# patch in node_modules:
#   git add -f <original file>
#   perform the patch
#   git diff --patch node_modules/
#   cleanup the original file
# apply patches: make patch
# undo patches: make patch-undo

# only reasonable way to run git apply is from the git root
GIT_ROOT=$(shell git rev-parse --show-toplevel)
CWD=$(shell realpath --relative-to="${GIT_ROOT}" .)

patch:
	cd ${GIT_ROOT} ; \
	for f in ${CWD}/munge-*.patch; do \
		echo applying $$f ; \
		git apply $$f ; \
	done

patch-undo:
	cd ${GIT_ROOT} ; \
	for f in ${CWD}/munge-*.patch; do \
		echo applying $$f ; \
		git apply -R $$f ; \
	done
