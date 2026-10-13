# vscode-hacker-meta — umbrella build/install across every extension submodule.
#
#   make build              -> `make build`   in each _submodules/*/ that has a Makefile
#   make install            -> `make install` in each _submodules/*/ that has a Makefile
#   make install-code-server -> install the built VSIXs into the compose code-server
#
# A failing submodule does not stop the others; the run exits non-zero and
# prints the list of failures at the end.
#
# Single submodule:
#   make -C _submodules/vscode-hacker-markdown build

SUBMODULES := $(sort $(dir $(wildcard _submodules/*/Makefile)))

.PHONY: build install list install-code-server

build install:
	@./local/make-all.sh $@ $(SUBMODULES)

# Install the built VSIXs into the docker-compose code-server (the shared dev
# harness). Distinct from `install`: that runs each submodule's `make install`
# (host `code` + host `code-server`). Run `make build` first.
install-code-server:
	@./local/install-code-server.sh

# Print the resolved submodule list (one per line).
list:
	@printf '%s\n' $(SUBMODULES)
