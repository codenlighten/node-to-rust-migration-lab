mod validate;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, RawQuery, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use futures::TryStreamExt;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use mongodb::{
    bson::{doc, Bson, DateTime, Document},
    error::{Error as MongoError, ErrorKind, WriteFailure},
    options::{IndexOptions, ReturnDocument},
    Client, ClientSession, Collection, Database, IndexModel,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tower::Layer;
use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc, time::Instant};
use validate::*;

// ---------------------------------------------------------------- errors

struct ApiError {
    status: u16,
    code: &'static str,
    message: String,
    details: Option<Value>,
}

impl ApiError {
    fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), details: None }
    }
    fn with(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
    fn validation(details: Details) -> Self {
        Self::new(400, "VALIDATION_ERROR", "Request validation failed").with(Value::Array(details))
    }
    fn not_found(what: &str) -> Self {
        Self::new(404, "NOT_FOUND", format!("{what} not found"))
    }
}

impl From<MongoError> for ApiError {
    fn from(e: MongoError) -> Self {
        eprintln!("{}", json!({"level":"error","impl":"rust","err":e.to_string()}));
        ApiError::new(500, "INTERNAL", "Internal server error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut err = json!({ "code": self.code, "message": self.message });
        if let Some(d) = self.details {
            err["details"] = d;
        }
        (StatusCode::from_u16(self.status).unwrap(), Json(json!({ "error": err }))).into_response()
    }
}

type R = Result<Response, ApiError>;

fn ok(v: Value) -> R {
    Ok(Json(v).into_response())
}
fn status(code: u16, v: Value) -> R {
    Ok((StatusCode::from_u16(code).unwrap(), Json(v)).into_response())
}

// ---------------------------------------------------------------- state & helpers

struct App {
    client: Client,
    db: Database,
    users: Collection<Document>,
    products: Collection<Document>,
    orders: Collection<Document>,
    counters: Collection<Document>,
    secret: String,
    admin_email: String,
}
type S = State<Arc<App>>;

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    role: String,
    exp: usize,
}

/// What is read from a presented token. `exp` and `nbf` are checked by jsonwebtoken from the same payload, which also
/// allows the fractional times that the Node service accepts.
#[derive(Deserialize)]
struct Caller {
    sub: String,
    role: String,
    #[serde(default, deserialize_with = "present")]
    nbf: Option<Value>,
}

/// Keeps `"nbf": null` (`Some(Null)`) apart from a token with no `nbf` at all (`None`).
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// Numeric BSON field as i64, tolerant of Int32/Int64/Double (the Node driver may write either).
fn num(d: &Document, k: &str) -> i64 {
    match d.get(k) {
        Some(Bson::Int32(i)) => *i as i64,
        Some(Bson::Int64(i)) => *i,
        Some(Bson::Double(f)) => *f as i64,
        _ => 0,
    }
}
fn text(d: &Document, k: &str) -> String {
    d.get_str(k).unwrap_or("").to_string()
}
fn iso(d: &Document, k: &str) -> String {
    let ms = d.get_datetime(k).map(|t| t.timestamp_millis()).unwrap_or(0);
    chrono::DateTime::from_timestamp_millis(ms).unwrap().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn product_out(p: &Document) -> Value {
    json!({
        "id": num(p, "_id"), "sku": text(p, "sku"), "name": text(p, "name"), "description": text(p, "description"),
        "priceCents": num(p, "priceCents"), "stock": num(p, "stock"), "active": p.get_bool("active").unwrap_or(false),
        "createdAt": iso(p, "createdAt"), "updatedAt": iso(p, "updatedAt"),
    })
}
fn order_out(o: &Document) -> Value {
    let items: Vec<Value> = o
        .get_array("items")
        .map(|a| {
            a.iter()
                .filter_map(|b| b.as_document())
                .map(|i| json!({"productId": num(i,"productId"), "quantity": num(i,"quantity"), "unitPriceCents": num(i,"unitPriceCents")}))
                .collect()
        })
        .unwrap_or_default();
    json!({
        "id": num(o, "_id"), "userId": num(o, "userId"), "status": text(o, "status"), "totalCents": num(o, "totalCents"),
        "items": items, "createdAt": iso(o, "createdAt"), "updatedAt": iso(o, "updatedAt"),
    })
}

fn is_dup(e: &MongoError) -> bool {
    matches!(&*e.kind, ErrorKind::Write(WriteFailure::WriteError(w)) if w.code == 11000)
}

fn parse_body(b: &Bytes) -> Result<Obj, ApiError> {
    // Node's UTF-8 body decoding drops a leading BOM before JSON.parse; do the same.
    let b: &[u8] = b.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(b);
    let v: Option<Value> = if b.is_empty() {
        None
    } else {
        Some(serde_json::from_slice(b).map_err(|_| ApiError::new(400, "VALIDATION_ERROR", "Malformed JSON body"))?)
    };
    match v {
        Some(Value::Object(o)) => Ok(o),
        _ => Err(ApiError::new(400, "VALIDATION_ERROR", "Request body must be a JSON object")),
    }
}

fn id_param(v: &str) -> Result<i32, ApiError> {
    if v.is_empty() || v.len() > 10 || !v.bytes().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::validation(vec![detail("id", "must be a positive integer")]));
    }
    let n: i64 = v.parse().unwrap();
    if n < 1 || n > MAX_INT32 {
        return Err(ApiError::validation(vec![detail("id", "must be a positive integer")]));
    }
    Ok(n as i32)
}

/// Query parsing with Express "simple" semantics: percent-decoding, '+' as space, and a repeated key
/// becomes an array in Node, which no validator accepts. Mark such keys with a sentinel that fails every check.
const MANY: &str = "\u{0}";
fn parse_query(raw: Option<String>) -> HashMap<String, String> {
    let mut m: HashMap<String, String> = HashMap::new();
    for (k, v) in form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        let k = k.into_owned();
        if m.contains_key(&k) {
            m.insert(k, MANY.to_string());
        } else {
            m.insert(k, v.into_owned());
        }
    }
    m
}

fn digits(v: &str, max_len: usize) -> bool {
    !v.is_empty() && v.len() <= max_len && v.bytes().all(|c| c.is_ascii_digit())
}

fn page_params(q: &HashMap<String, String>, d: &mut Details) -> (i64, i64) {
    let mut num = |f: &str, def: i64, min: i64, max: i64| -> i64 {
        match q.get(f) {
            None => def,
            Some(v) if !digits(v, 9) => {
                d.push(detail(f, "must be an integer"));
                def
            }
            Some(v) => {
                let n: i64 = v.parse().unwrap();
                if n < min || n > max {
                    d.push(detail(f, &format!("must be between {min} and {max}")));
                    def
                } else {
                    n
                }
            }
        }
    };
    let page = num("page", 1, 1, 1_000_000);
    let size = num("pageSize", 20, 1, 100);
    (page, size)
}

async fn next_id(a: &App, name: &str, session: Option<&mut ClientSession>) -> Result<i32, MongoError> {
    let op = a
        .counters
        .find_one_and_update(doc! {"_id": name}, doc! {"$inc": {"seq": 1i32}})
        .upsert(true)
        .return_document(ReturnDocument::After);
    let r = match session {
        Some(s) => op.session(s).await?,
        None => op.await?,
    };
    Ok(r.map(|d| num(&d, "seq") as i32).unwrap_or(1))
}

// ---------------------------------------------------------------- auth

fn auth(a: &App, h: &HeaderMap) -> Result<Caller, ApiError> {
    let hv = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    let tok = match hv {
        Some(v) if v.starts_with("Bearer ") => &v[7..],
        _ => return Err(ApiError::new(401, "UNAUTHORIZED", "Missing or invalid Authorization header")),
    };
    let mut val = Validation::new(Algorithm::HS256);
    val.leeway = 0;
    val.set_required_spec_claims(&["exp"]);
    val.validate_nbf = true; // off by default in this crate; the Node service refuses a not-yet-valid token
    decode::<Caller>(tok, &DecodingKey::from_secret(a.secret.as_bytes()), &val)
        .ok()
        .filter(|t| t.claims.nbf != Some(Value::Null)) // the crate reads null as absent; Node refuses it
        .filter(|t| t.claims.role == "customer" || t.claims.role == "admin")
        .map(|t| t.claims)
        .ok_or_else(|| ApiError::new(401, "UNAUTHORIZED", "Invalid or expired token"))
}
fn admin(a: &App, h: &HeaderMap) -> Result<Caller, ApiError> {
    let c = auth(a, h)?;
    if c.role != "admin" {
        return Err(ApiError::new(403, "FORBIDDEN", "Admin role required"));
    }
    Ok(c)
}
fn uid(c: &Caller) -> i32 {
    c.sub.parse().unwrap_or(0)
}

// ---------------------------------------------------------------- health

async fn health() -> R {
    ok(json!({"status": "ok"}))
}
async fn ready(State(a): S) -> R {
    match a.db.run_command(doc! {"ping": 1}).await {
        Ok(_) => ok(json!({"status": "ready"})),
        Err(_) => status(503, json!({"status": "unavailable"})),
    }
}

// ---------------------------------------------------------------- users

async fn register(State(a): S, body: Bytes) -> R {
    let b = parse_body(&body)?;
    let mut d = vec![];
    let email = str_field(&b, "email", 3, 254, &mut d, true);
    if let Some(e) = &email {
        if !valid_email(e) {
            d.push(detail("email", "must be a valid email address"));
        }
    }
    let password = str_field(&b, "password", 8, 72, &mut d, true);
    let name = str_field(&b, "name", 1, 100, &mut d, true);
    if !d.is_empty() {
        return Err(ApiError::validation(d));
    }
    let lower = email.unwrap().to_lowercase();
    let pw = password.unwrap();
    let hash = tokio::task::spawn_blocking(move || bcrypt::hash(pw, 10)).await.unwrap().map_err(|_| ApiError::new(500, "INTERNAL", "Internal server error"))?;
    let role = if lower == a.admin_email.to_lowercase() { "admin" } else { "customer" };
    let id = next_id(&a, "users", None).await?;
    let name = name.unwrap();
    let u = doc! {"_id": id, "email": &lower, "name": &name, "passwordHash": hash, "role": role, "createdAt": DateTime::now()};
    match a.users.insert_one(u).await {
        Ok(_) => status(201, json!({"id": id, "email": lower, "name": name, "role": role})),
        Err(e) if is_dup(&e) => Err(ApiError::new(409, "EMAIL_TAKEN", "Email is already registered")),
        Err(e) => Err(e.into()),
    }
}

async fn login(State(a): S, body: Bytes) -> R {
    let b = parse_body(&body)?;
    let mut d = vec![];
    let email = str_field(&b, "email", 1, 254, &mut d, true);
    let password = str_field(&b, "password", 1, 72, &mut d, true);
    if !d.is_empty() {
        return Err(ApiError::validation(d));
    }
    let u = a.users.find_one(doc! {"email": email.unwrap().to_lowercase()}).await?;
    let bad = || ApiError::new(401, "INVALID_CREDENTIALS", "Invalid email or password");
    let u = u.ok_or_else(bad)?;
    let pw = password.unwrap();
    let hash = text(&u, "passwordHash");
    let good = tokio::task::spawn_blocking(move || bcrypt::verify(pw, &hash).unwrap_or(false)).await.unwrap();
    if !good {
        return Err(bad());
    }
    let exp = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 3600) as usize;
    let claims = Claims { sub: num(&u, "_id").to_string(), role: text(&u, "role"), exp };
    let token = encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(a.secret.as_bytes()))
        .map_err(|_| ApiError::new(500, "INTERNAL", "Internal server error"))?;
    ok(json!({"token": token, "user": {"id": num(&u,"_id"), "email": text(&u,"email"), "name": text(&u,"name"), "role": text(&u,"role")}}))
}

async fn me(State(a): S, h: HeaderMap) -> R {
    let c = auth(&a, &h)?;
    let u = a.users.find_one(doc! {"_id": uid(&c)}).await?.ok_or_else(|| ApiError::new(401, "UNAUTHORIZED", "Invalid or expired token"))?;
    ok(json!({"id": num(&u,"_id"), "email": text(&u,"email"), "name": text(&u,"name"), "role": text(&u,"role")}))
}

// ---------------------------------------------------------------- products

fn sort_doc(name: &str) -> Option<Document> {
    Some(match name {
        "id" => doc! {"_id": 1},
        "newest" => doc! {"_id": -1},
        "name" => doc! {"name": 1, "_id": 1},
        "price_asc" => doc! {"priceCents": 1, "_id": 1},
        "price_desc" => doc! {"priceCents": -1, "_id": 1},
        _ => return None,
    })
}

async fn list_products(State(a): S, RawQuery(raw): RawQuery) -> R {
    let q = parse_query(raw);
    let mut d = vec![];
    let (page, size) = page_params(&q, &mut d);
    let mut money = |f: &str| -> Option<i32> {
        match q.get(f) {
            None => None,
            Some(v) if !digits(v, 9) => {
                d.push(detail(f, "must be an integer"));
                None
            }
            Some(v) => Some(v.parse().unwrap()),
        }
    };
    let min_price = money("minPrice");
    let max_price = money("maxPrice");
    let mut search = None;
    if let Some(s) = q.get("search") {
        if s == MANY || s.chars().count() > 100 {
            d.push(detail("search", "must be at most 100 characters"));
        } else {
            search = Some(s.clone());
        }
    }
    let mut sort = "id".to_string();
    if let Some(s) = q.get("sort") {
        if sort_doc(s).is_none() {
            d.push(detail("sort", "must be one of id, newest, name, price_asc, price_desc"));
        } else {
            sort = s.clone();
        }
    }
    if !d.is_empty() {
        return Err(ApiError::validation(d));
    }
    let mut filter = doc! {"active": true};
    if min_price.is_some() || max_price.is_some() {
        let mut r = Document::new();
        if let Some(m) = min_price {
            r.insert("$gte", m);
        }
        if let Some(m) = max_price {
            r.insert("$lte", m);
        }
        filter.insert("priceCents", r);
    }
    if let Some(s) = search.filter(|s| !s.is_empty()) {
        let rx = doc! {"$regex": escape_regex(&s), "$options": "i"};
        filter.insert("$or", vec![doc! {"name": rx.clone()}, doc! {"sku": rx}]);
    }
    let cursor = a.products.find(filter.clone()).sort(sort_doc(&sort).unwrap()).skip(((page - 1) * size) as u64).limit(size).await?;
    let docs: Vec<Document> = cursor.try_collect().await?;
    let total = a.products.count_documents(filter).await?;
    ok(json!({"items": docs.iter().map(product_out).collect::<Vec<_>>(), "page": page, "pageSize": size, "total": total}))
}

async fn get_product(State(a): S, Path(id): Path<String>) -> R {
    let p = a.products.find_one(doc! {"_id": id_param(&id)?, "active": true}).await?.ok_or_else(|| ApiError::not_found("Product"))?;
    ok(product_out(&p))
}

async fn create_product(State(a): S, h: HeaderMap, body: Bytes) -> R {
    admin(&a, &h)?;
    let b = parse_body(&body)?;
    let mut d = vec![];
    let sku = str_field(&b, "sku", 1, 64, &mut d, true);
    let name = str_field(&b, "name", 1, 200, &mut d, true);
    let description = str_field(&b, "description", 0, 2000, &mut d, false);
    let price = int_field(&b, "priceCents", 0, MAX_INT32, &mut d, true);
    let stock = int_field(&b, "stock", 0, 1_000_000, &mut d, false);
    if !d.is_empty() {
        return Err(ApiError::validation(d));
    }
    let id = next_id(&a, "products", None).await?;
    let now = DateTime::now();
    let p = doc! {"_id": id, "sku": sku.unwrap(), "name": name.unwrap(), "description": description.unwrap_or_default(),
        "priceCents": price.unwrap() as i32, "stock": stock.unwrap_or(0) as i32, "active": true, "createdAt": now, "updatedAt": now};
    match a.products.insert_one(p.clone()).await {
        Ok(_) => status(201, product_out(&p)),
        Err(e) if is_dup(&e) => Err(ApiError::new(409, "SKU_TAKEN", "SKU is already in use")),
        Err(e) => Err(e.into()),
    }
}

async fn update_product(State(a): S, h: HeaderMap, Path(id): Path<String>, body: Bytes) -> R {
    admin(&a, &h)?;
    let id = id_param(&id)?;
    let b = parse_body(&body)?;
    let mut d = vec![];
    let name = str_field(&b, "name", 1, 200, &mut d, false);
    let description = str_field(&b, "description", 0, 2000, &mut d, false);
    let price = int_field(&b, "priceCents", 0, MAX_INT32, &mut d, false);
    let active = bool_field(&b, "active", &mut d);
    if d.is_empty() && name.is_none() && description.is_none() && price.is_none() && active.is_none() {
        d.push(detail("body", "at least one field is required"));
    }
    if !d.is_empty() {
        return Err(ApiError::validation(d));
    }
    let mut set = doc! {"updatedAt": DateTime::now()};
    if let Some(v) = name {
        set.insert("name", v);
    }
    if let Some(v) = description {
        set.insert("description", v);
    }
    if let Some(v) = price {
        set.insert("priceCents", v as i32);
    }
    if let Some(v) = active {
        set.insert("active", v);
    }
    let p = a.products.find_one_and_update(doc! {"_id": id}, doc! {"$set": set}).return_document(ReturnDocument::After).await?
        .ok_or_else(|| ApiError::not_found("Product"))?;
    ok(product_out(&p))
}

async fn delete_product(State(a): S, h: HeaderMap, Path(id): Path<String>) -> R {
    admin(&a, &h)?;
    let r = a.products.update_one(doc! {"_id": id_param(&id)?, "active": true}, doc! {"$set": {"active": false, "updatedAt": DateTime::now()}}).await?;
    if r.matched_count == 0 {
        return Err(ApiError::not_found("Product"));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn adjust_stock(State(a): S, h: HeaderMap, Path(id): Path<String>, body: Bytes) -> R {
    admin(&a, &h)?;
    let id = id_param(&id)?;
    let b = parse_body(&body)?;
    let mut d = vec![];
    let delta = int_field(&b, "delta", -1_000_000, 1_000_000, &mut d, true);
    if d.is_empty() && delta == Some(0) {
        d.push(detail("delta", "must not be zero"));
    }
    if !d.is_empty() {
        return Err(ApiError::validation(d));
    }
    let delta = delta.unwrap() as i32;
    let p = a.products.find_one_and_update(
        doc! {"_id": id, "active": true, "stock": {"$gte": -delta}},
        doc! {"$inc": {"stock": delta}, "$set": {"updatedAt": DateTime::now()}},
    ).return_document(ReturnDocument::After).await?;
    if let Some(p) = p {
        return ok(product_out(&p));
    }
    let cur = a.products.find_one(doc! {"_id": id, "active": true}).await?.ok_or_else(|| ApiError::not_found("Product"))?;
    Err(ApiError::new(409, "INSUFFICIENT_STOCK", "Insufficient stock")
        .with(json!([{"productId": id, "requested": -delta, "available": num(&cur, "stock")}])))
}

// ---------------------------------------------------------------- transactions

enum TxErr {
    Api(ApiError),
    Mongo(MongoError),
}
impl From<MongoError> for TxErr {
    fn from(e: MongoError) -> Self {
        TxErr::Mongo(e)
    }
}
impl From<ApiError> for TxErr {
    fn from(e: ApiError) -> Self {
        TxErr::Api(e)
    }
}

type TxFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, TxErr>> + Send + 'a>>;

/// Run `f` in a transaction, retrying on TransientTransactionError like the Node driver's withTransaction.
async fn run_tx<T, F>(a: &App, mut f: F) -> Result<T, ApiError>
where
    F: for<'s> FnMut(&'s mut ClientSession) -> TxFuture<'s, T>,
{
    // Like the Node driver's withTransaction: retry transient conflicts within a time budget, with jittered backoff.
    let deadline = Instant::now() + std::time::Duration::from_secs(10);
    let mut attempt: u64 = 0;
    loop {
        if attempt > 0 {
            if Instant::now() > deadline {
                eprintln!("{}", json!({"level":"error","impl":"rust","err":"transaction retry budget exhausted","attempts":attempt}));
                return Err(ApiError::new(500, "INTERNAL", "Internal server error"));
            }
            let jitter = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() as u64) % (2 + attempt.min(20) * 3);
            tokio::time::sleep(std::time::Duration::from_millis(1 + jitter)).await;
        }
        attempt += 1;
        let mut s = a.client.start_session().await?;
        s.start_transaction().await?;
        match f(&mut s).await {
            Ok(v) => loop {
                match s.commit_transaction().await {
                    Ok(_) => return Ok(v),
                    Err(e) if e.contains_label("UnknownTransactionCommitResult") => continue,
                    Err(e) if e.contains_label("TransientTransactionError") => break,
                    Err(e) => return Err(e.into()),
                }
            },
            Err(TxErr::Api(e)) => {
                let _ = s.abort_transaction().await;
                return Err(e);
            }
            Err(TxErr::Mongo(e)) => {
                let _ = s.abort_transaction().await;
                if e.contains_label("TransientTransactionError") {
                    continue;
                }
                return Err(e.into());
            }
        }
    }
}

// ---------------------------------------------------------------- orders

async fn create_order(State(a): S, h: HeaderMap, body: Bytes) -> R {
    let c = auth(&a, &h)?;
    let b = parse_body(&body)?;
    let mut d: Details = vec![];
    let mut lines: Vec<(i32, i32)> = vec![];
    match b.get("items") {
        Some(Value::Array(items)) if (1..=20).contains(&items.len()) => {
            let mut seen = std::collections::HashSet::new();
            for (i, it) in items.iter().enumerate() {
                let Value::Object(o) = it else {
                    d.push(detail(&format!("items[{i}]"), "must be an object"));
                    continue;
                };
                let mut sub = vec![];
                let pid = int_field(o, "productId", 1, MAX_INT32, &mut sub, true);
                let qty = int_field(o, "quantity", 1, 1000, &mut sub, true);
                for s in sub {
                    d.push(detail(&format!("items[{i}].{}", s["field"].as_str().unwrap()), s["message"].as_str().unwrap()));
                }
                if let Some(p) = pid {
                    if !seen.insert(p) {
                        d.push(detail(&format!("items[{i}].productId"), "must be unique"));
                    }
                }
                if let (Some(p), Some(q)) = (pid, qty) {
                    lines.push((p as i32, q as i32));
                }
            }
        }
        Some(Value::Array(_)) => d.push(detail("items", "must contain between 1 and 20 entries")),
        _ => d.push(detail("items", "must be an array")),
    }
    if !d.is_empty() {
        return Err(ApiError::validation(d));
    }
    lines.sort();
    let order_id = next_id(&a, "orders", None).await?;
    let user_id = uid(&c);
    let now = DateTime::now();

    let a2 = a.clone();
    let order = run_tx(&a, |s| {
        let a = a2.clone();
        let lines = lines.clone();
        Box::pin(async move {
            let mut items = vec![];
            let mut total: i64 = 0;
            for (pid, qty) in lines {
                let p = a.products.find_one_and_update(
                    doc! {"_id": pid, "active": true, "stock": {"$gte": qty}},
                    doc! {"$inc": {"stock": -qty}, "$set": {"updatedAt": now}},
                ).return_document(ReturnDocument::Before).session(&mut *s).await?;
                let Some(p) = p else {
                    let cur = a.products.find_one(doc! {"_id": pid, "active": true}).session(&mut *s).await?;
                    return Err(match cur {
                        None => ApiError::new(404, "NOT_FOUND", format!("Product {pid} not found")),
                        Some(cur) => ApiError::new(409, "INSUFFICIENT_STOCK", "Insufficient stock")
                            .with(json!([{"productId": pid, "requested": qty, "available": num(&cur, "stock")}])),
                    }.into());
                };
                let price = num(&p, "priceCents");
                items.push(doc! {"productId": pid, "quantity": qty, "unitPriceCents": price as i32});
                total += price * qty as i64;
            }
            if total > MAX_INT32 {
                return Err(ApiError::validation(vec![detail("items", "order total is too large")]).into());
            }
            let o = doc! {"_id": order_id, "userId": user_id, "status": "pending", "totalCents": total as i32,
                "items": items, "createdAt": now, "updatedAt": now};
            a.orders.insert_one(o.clone()).session(&mut *s).await?;
            Ok(o)
        })
    }).await?;
    status(201, order_out(&order))
}

async fn load_order(a: &App, c: &Caller, id: i32) -> Result<Document, ApiError> {
    let f = if c.role == "admin" { doc! {"_id": id} } else { doc! {"_id": id, "userId": uid(c)} };
    a.orders.find_one(f).await?.ok_or_else(|| ApiError::not_found("Order"))
}

async fn list_orders(State(a): S, h: HeaderMap, RawQuery(raw): RawQuery) -> R {
    let q = parse_query(raw);
    let c = auth(&a, &h)?;
    let mut d = vec![];
    let (page, size) = page_params(&q, &mut d);
    if !d.is_empty() {
        return Err(ApiError::validation(d));
    }
    let f = doc! {"userId": uid(&c)};
    let docs: Vec<Document> = a.orders.find(f.clone()).sort(doc! {"_id": -1}).skip(((page - 1) * size) as u64).limit(size).await?.try_collect().await?;
    let total = a.orders.count_documents(f).await?;
    ok(json!({"items": docs.iter().map(order_out).collect::<Vec<_>>(), "page": page, "pageSize": size, "total": total}))
}

async fn get_order(State(a): S, h: HeaderMap, Path(id): Path<String>) -> R {
    let c = auth(&a, &h)?;
    ok(order_out(&load_order(&a, &c, id_param(&id)?).await?))
}

fn state_err(s: &str) -> ApiError {
    ApiError::new(409, "INVALID_STATE", format!("Order is {s}, expected pending"))
}

async fn pay_order(State(a): S, h: HeaderMap, Path(id): Path<String>, body: Bytes) -> R {
    let c = auth(&a, &h)?;
    let id = id_param(&id)?;
    let b = parse_body(&body)?;
    let mut d = vec![];
    let token = str_field(&b, "cardToken", 1, 100, &mut d, true);
    if !d.is_empty() {
        return Err(ApiError::validation(d));
    }
    let o = load_order(&a, &c, id).await?;
    if text(&o, "status") != "pending" {
        return Err(state_err(&text(&o, "status")));
    }
    if token.as_deref() == Some("tok_decline") {
        return Err(ApiError::new(402, "PAYMENT_DECLINED", "Payment declined"));
    }
    let r = a.orders.find_one_and_update(doc! {"_id": id, "status": "pending"}, doc! {"$set": {"status": "paid", "updatedAt": DateTime::now()}})
        .return_document(ReturnDocument::After).await?;
    match r {
        Some(o) => ok(order_out(&o)),
        None => {
            let cur = a.orders.find_one(doc! {"_id": id}).await?.unwrap();
            Err(state_err(&text(&cur, "status")))
        }
    }
}

async fn cancel_order(State(a): S, h: HeaderMap, Path(id): Path<String>) -> R {
    let c = auth(&a, &h)?;
    let id = id_param(&id)?;
    let o = load_order(&a, &c, id).await?;
    if text(&o, "status") != "pending" {
        return Err(state_err(&text(&o, "status")));
    }
    let a2 = a.clone();
    let out = run_tx(&a, |s| {
        let a = a2.clone();
        Box::pin(async move {
            let upd = a.orders.find_one_and_update(doc! {"_id": id, "status": "pending"}, doc! {"$set": {"status": "cancelled", "updatedAt": DateTime::now()}})
                .return_document(ReturnDocument::After).session(&mut *s).await?;
            let Some(upd) = upd else {
                let cur = a.orders.find_one(doc! {"_id": id}).session(&mut *s).await?.unwrap();
                return Err(state_err(&text(&cur, "status")).into());
            };
            let mut items: Vec<(i64, i64)> = upd.get_array("items").unwrap().iter().filter_map(|b| b.as_document()).map(|i| (num(i, "productId"), num(i, "quantity"))).collect();
            items.sort();
            for (pid, qty) in items {
                a.products.update_one(doc! {"_id": pid as i32}, doc! {"$inc": {"stock": qty as i32}}).session(&mut *s).await?;
            }
            Ok(upd)
        })
    }).await?;
    ok(order_out(&out))
}

// ---------------------------------------------------------------- plumbing

/// Express matches routes case-insensitively and ignores one trailing slash; reproduce that so existing
/// clients keep working. Route paths contain only lowercase literals and numeric ids, so lowercasing is safe.
fn normalise_path<B>(mut req: axum::http::Request<B>) -> axum::http::Request<B> {
    let uri = req.uri();
    let mut path = uri.path().to_ascii_lowercase();
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    let pq = match uri.query() {
        Some(q) => format!("{path}?{q}"),
        None => path,
    };
    if let Ok(new_uri) = pq.parse::<axum::http::Uri>() {
        *req.uri_mut() = new_uri;
    }
    req
}

async fn fallback() -> Response {
    ApiError::new(404, "NOT_FOUND", "Route not found").into_response()
}

async fn limit_and_log(req: Request, next: Next) -> Response {
    let id = req.headers().get("x-request-id").and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let too_big = req.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok()).map_or(false, |n| n > 102_400);
    let t0 = Instant::now();
    let mut res = if too_big {
        ApiError::new(413, "PAYLOAD_TOO_LARGE", "Request body too large").into_response()
    } else {
        next.run(req).await
    };
    if let Ok(v) = HeaderValue::from_str(&id) {
        res.headers_mut().insert("x-request-id", v);
    }
    if path != "/health" {
        println!("{}", json!({"ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "impl": "rust", "reqId": id,
            "method": method, "path": path, "status": res.status().as_u16(), "ms": (t0.elapsed().as_secs_f64() * 100000.0).round() / 100.0}));
    }
    res
}

async fn init_db(db: &Database) -> Result<(), MongoError> {
    let existing = db.list_collection_names().await?;
    for n in ["users", "products", "orders", "counters"] {
        if !existing.iter().any(|e| e == n) {
            let _ = db.create_collection(n).await;
        }
    }
    let unique = || IndexOptions::builder().unique(true).build();
    db.collection::<Document>("users").create_index(IndexModel::builder().keys(doc! {"email": 1}).options(unique()).build()).await?;
    db.collection::<Document>("products").create_index(IndexModel::builder().keys(doc! {"sku": 1}).options(unique()).build()).await?;
    db.collection::<Document>("orders").create_index(IndexModel::builder().keys(doc! {"userId": 1, "_id": 1}).build()).await?;
    Ok(())
}

#[tokio::main]
async fn main() {
    let url = std::env::var("MONGO_URL").unwrap_or_else(|_| "mongodb://localhost:27017/?replicaSet=rs0".into());
    let db_name = std::env::var("MONGO_DB").unwrap_or_else(|_| "lab".into());
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3002);
    let secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| "dev-only-secret-change-me".into());
    let admin_email = std::env::var("ADMIN_EMAIL").unwrap_or_else(|_| "admin@example.com".into());

    let mut opts = mongodb::options::ClientOptions::parse(&url).await.expect("bad MONGO_URL");
    opts.max_pool_size = Some(50);
    let client = Client::with_options(opts).expect("client");
    let db = client.database(&db_name);
    for i in 0.. {
        match init_db(&db).await {
            Ok(_) => break,
            Err(e) if i >= 30 => panic!("mongo init failed: {e}"),
            Err(_) => tokio::time::sleep(std::time::Duration::from_secs(1)).await,
        }
    }
    let app_state = Arc::new(App {
        users: db.collection("users"), products: db.collection("products"), orders: db.collection("orders"), counters: db.collection("counters"),
        client, db, secret, admin_email,
    });

    let router = Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/me", get(me))
        .route("/api/products", get(list_products).post(create_product))
        .route("/api/products/{id}", get(get_product).put(update_product).delete(delete_product))
        .route("/api/products/{id}/stock", patch(adjust_stock))
        .route("/api/orders", get(list_orders).post(create_order))
        .route("/api/orders/{id}", get(get_order))
        .route("/api/orders/{id}/pay", post(pay_order))
        .route("/api/orders/{id}/cancel", post(cancel_order))
        .fallback(fallback)
        .method_not_allowed_fallback(fallback)
        .layer(DefaultBodyLimit::max(102_400))
        .layer(middleware::from_fn(limit_and_log))
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind");
    println!("{}", json!({"ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "impl": "rust", "msg": "listening", "port": port, "db": db_name}));
    let router = tower::util::MapRequestLayer::new(normalise_path).layer(router);
    axum::serve(listener, axum::ServiceExt::<Request>::into_make_service(router))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}
