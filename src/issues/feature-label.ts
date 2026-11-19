import type { LabelSpec } from './host.ts';

/**
 * The default `github.featureLabel`: a feature request, which the status push gives an untrusted author's task or
 * design issue in place of its restricted label, so it waits for an acceptor rather than reading as work.
 */
export const FEATURE_LABEL = 'feature';

/** The feature label as teamrig makes it in a repository that lacks it. */
export const FEATURE_LABEL_SPEC: LabelSpec = {
  name: FEATURE_LABEL,
  color: 'a2eeef',
  description: 'Type: a new capability or a change in behaviour',
};
