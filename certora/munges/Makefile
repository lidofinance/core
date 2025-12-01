# munge in node_modules:
#   git add -f <original file>
#   perform the munge
#   git diff --patch node_modules/
#   cleanup the original file
# apply munges: make munge
# undo munges: make unmunge

# only reasonable way to run git apply is from the git root
GIT_ROOT=$(shell git rev-parse --show-toplevel)
CWD=$(shell realpath --relative-to="${GIT_ROOT}" .)

munge:
	cd ${GIT_ROOT} ; \
	for f in ${CWD}/munge-*.patch; do \
		echo applying $$f ; \
		git apply $$f ; \
	done

unmunge:
	cd ${GIT_ROOT} ; \
	for f in ${CWD}/munge-*.patch; do \
		echo applying $$f ; \
		git apply -R $$f ; \
	done
