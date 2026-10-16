// The flows the action suite calls, from the suite's SPEC.
export const SPEC_FLOWS = [
  "triage.decide", "triage.apply", "resolve.decide", "resolve.apply", "review.decide", "review.apply",
  "closeout.merged", "closeout.released", "release.plan", "release.gate", "release.notes", "release.publish",
];
