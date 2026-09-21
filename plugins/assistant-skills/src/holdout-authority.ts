// The holdout authority is a self-contained signing/verification wire contract. It lives in
// @dsh-enhanced/task-acceptance-contract so the evaluator can consume its types without a build
// dependency on the full assistant-skills package. This re-export keeps the stable
// "@dsh-enhanced/assistant-skills/holdout-authority" subpath (and the Host's runtime import) working.
export * from '@dsh-enhanced/task-acceptance-contract/holdout-authority'
