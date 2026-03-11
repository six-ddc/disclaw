# Disclaw — Cross-platform service management

MANAGE := service/manage.sh

.DEFAULT_GOAL := help

## ── Development ───────────────────────────────────────

.PHONY: dev typecheck

dev:       ## Start with hot reload (bun --watch)
	bun run dev

typecheck: ## Run TypeScript type checking
	bunx tsc --noEmit

## ── Service ───────────────────────────────────────────

.PHONY: install uninstall start stop restart status logs

install:   ## Install as service (macOS: LaunchAgent, Linux: systemd)
	@bash $(MANAGE) install

uninstall: ## Remove service registration
	@bash $(MANAGE) uninstall

start:     ## Start the service
	@bash $(MANAGE) start

stop:      ## Stop the service
	@bash $(MANAGE) stop

restart:   ## Restart the service
	@bash $(MANAGE) restart

status:    ## Show service status
	@bash $(MANAGE) status

logs:      ## Follow service logs
	@bash $(MANAGE) logs

## ── Deploy ────────────────────────────────────────────

.PHONY: deploy

deploy: typecheck restart ## Type-check + restart

## ── Help ──────────────────────────────────────────────

.PHONY: help

help:      ## Show this help
	@echo "Disclaw — Service management"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""
	@echo "Platform: $$(uname -s) (auto-detected)"
