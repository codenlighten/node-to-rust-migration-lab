.PHONY: up down test verify-migration benchmark verify-local
up:                ## start the demo stack (dashboard on :3000)
	docker compose up --build -d
down:
	docker compose down -v
verify-migration:  ## run contract + concurrency verification in containers; reports land in migration-tests/report/
	docker compose --profile verify up --build --abort-on-container-exit --exit-code-from verify verify
test: verify-migration
benchmark:         ## reproducible benchmark against the verify backends (see benchmarks/README.md)
	./benchmarks/benchmark.sh
