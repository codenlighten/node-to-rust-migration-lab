FROM rust:1-bookworm AS build
WORKDIR /app
# Cache dependencies: build a stub first so source edits don't invalidate the dependency layer.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src target/release/deps/backend_rust*
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN useradd --system --no-create-home app
COPY --from=build /app/target/release/backend-rust /usr/local/bin/backend-rust
USER app
EXPOSE 3002
ENV PORT=3002
CMD ["backend-rust"]
