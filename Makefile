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

.PHONY: install uninstall start stop restart status logs link-skills unlink-skills

install:   ## Install as service + link skills
	@bash $(MANAGE) install
	@$(MAKE) --no-print-directory link-skills

uninstall: ## Remove service + unlink skills
	@$(MAKE) --no-print-directory unlink-skills
	@bash $(MANAGE) uninstall

link-skills: ## Symlink project skills to ~/.claude/skills/
	@mkdir -p ~/.claude/skills
	@for d in $(CURDIR)/skills/*/; do \
		name=$$(basename "$$d"); \
		if [ -L ~/.claude/skills/"$$name" ]; then \
			rm ~/.claude/skills/"$$name"; \
		fi; \
		ln -s "$$d" ~/.claude/skills/"$$name"; \
		echo "  Linked skill: $$name → $$d"; \
	done

unlink-skills: ## Remove skill symlinks from ~/.claude/skills/
	@for d in $(CURDIR)/skills/*/; do \
		name=$$(basename "$$d"); \
		if [ -L ~/.claude/skills/"$$name" ] && [ "$$(readlink ~/.claude/skills/"$$name")" = "$$d" ]; then \
			rm ~/.claude/skills/"$$name"; \
			echo "  Unlinked skill: $$name"; \
		fi; \
	done

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
