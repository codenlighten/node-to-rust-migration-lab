//! Hand-written validation, mirroring backend-node/src/validate.ts message-for-message.
use serde_json::{json, Map, Value};

pub type Obj = Map<String, Value>;
pub type Details = Vec<Value>;

pub const MAX_INT32: i64 = 2_147_483_647;

pub fn detail(field: &str, message: &str) -> Value {
    json!({ "field": field, "message": message })
}

pub fn str_field(o: &Obj, f: &str, min: usize, max: usize, d: &mut Details, required: bool) -> Option<String> {
    match o.get(f) {
        None | Some(Value::Null) => {
            if required {
                d.push(detail(f, "is required"));
            }
            None
        }
        Some(Value::String(s)) => {
            let n = s.chars().count(); // code points, like [...s].length in JS
            if n < min || n > max {
                d.push(detail(f, &format!("must be between {min} and {max} characters")));
                None
            } else {
                Some(s.clone())
            }
        }
        Some(_) => {
            d.push(detail(f, "must be a string"));
            None
        }
    }
}

/// JS `Number.isInteger` accepts 1.0 and 1e3; serde_json parses those as f64. Match JS.
pub fn int_field(o: &Obj, f: &str, min: i64, max: i64, d: &mut Details, required: bool) -> Option<i64> {
    match o.get(f) {
        None | Some(Value::Null) => {
            if required {
                d.push(detail(f, "is required"));
            }
            None
        }
        Some(Value::Number(n)) => {
            let x = match n.as_i64() {
                Some(i) => i as f64,
                None => n.as_f64().unwrap_or(f64::NAN),
            };
            if !x.is_finite() || x.fract() != 0.0 {
                d.push(detail(f, "must be an integer"));
                return None;
            }
            if x < min as f64 || x > max as f64 {
                d.push(detail(f, &format!("must be between {min} and {max}")));
                return None;
            }
            Some(x as i64)
        }
        Some(_) => {
            d.push(detail(f, "must be an integer"));
            None
        }
    }
}

pub fn bool_field(o: &Obj, f: &str, d: &mut Details) -> Option<bool> {
    match o.get(f) {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => {
            d.push(detail(f, "must be a boolean"));
            None
        }
    }
}

/// JavaScript's `\s` (what the original uses). Not Unicode White_Space: JS counts U+FEFF and not U+0085.
fn js_whitespace(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn valid_email(s: &str) -> bool {
    if s.chars().any(js_whitespace) {
        return false;
    }
    let parts: Vec<&str> = s.split('@').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return false;
    }
    match parts[1].find('.') {
        Some(i) => i > 0 && !parts[1].ends_with('.'),
        None => false,
    }
}

pub fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    //! Runs the shared vectors in api-contract/validation-vectors.json (backend-node/test runs the same file).
    use super::*;

    const VECTORS: &str = include_str!("../../api-contract/validation-vectors.json");

    fn vectors() -> Value {
        serde_json::from_str(VECTORS).unwrap()
    }

    #[test]
    fn email_vectors() {
        for c in vectors()["email"].as_array().unwrap() {
            let input = c["in"].as_str().unwrap();
            assert_eq!(valid_email(input), c["valid"].as_bool().unwrap(), "{input:?}");
        }
    }

    fn run_case(c: &Value, kind: &str) {
        let body = c["body"].as_str().unwrap();
        let o: Obj = serde_json::from_str::<Value>(body).unwrap().as_object().unwrap().clone();
        let (field, required) = (c["field"].as_str().unwrap(), c["required"].as_bool().unwrap());
        let (min, max) = (c["min"].as_i64().unwrap(), c["max"].as_i64().unwrap());
        let mut d: Details = vec![];
        let value = if kind == "str" {
            str_field(&o, field, min as usize, max as usize, &mut d, required).map(Value::from).unwrap_or(Value::Null)
        } else {
            int_field(&o, field, min, max, &mut d, required).map(Value::from).unwrap_or(Value::Null)
        };
        assert_eq!(value, c["expect"]["value"], "{body}");
        assert_eq!(Value::Array(d), c["expect"]["details"], "{body}");
    }

    #[test]
    fn str_vectors() {
        for c in vectors()["str"].as_array().unwrap() {
            run_case(c, "str");
        }
    }

    #[test]
    fn int_vectors() {
        for c in vectors()["int"].as_array().unwrap() {
            run_case(c, "int");
        }
    }

    #[test]
    fn escape_regex_vectors() {
        for c in vectors()["escapeRegex"].as_array().unwrap() {
            assert_eq!(escape_regex(c["in"].as_str().unwrap()), c["out"].as_str().unwrap());
        }
    }
}
