# vscode-hacker-meta — umbrella build/install across every extension submodule.
#
#   make build     -> `make build`   in each _submodules/*/ that has a Makefile
#   make install   -> `make install` in each _submodules/*/ that has a Makefile
#
# A failing submodule does not stop the others; the run exits non-zero and
# prints the list of failures at the end.
#
# Single submodule:
#   make -C _submodules/vscode-hacker-markdown build

SUBMODULES := $(sort $(dir $(wildcard _submodules/*/Makefile)))

.PHONY: build install list

build install:
	@./local/make-all.sh $@ $(SUBMODULES)

# Print the resolved submodule list (one per line).
list:
	@printf '%s\n' $(SUBMODULES)
