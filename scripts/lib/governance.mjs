export const OPERATIONAL_PROJECT_FIELDS = new Set(['Status', 'Size', 'Confidence', 'Evidence']);

export function shouldUpdateProjectValue(
  fieldName,
  currentValue,
  desiredValue,
  { newItem = false } = {},
) {
  if (newItem) return desiredValue !== undefined && desiredValue !== null && desiredValue !== '';
  if (
    OPERATIONAL_PROJECT_FIELDS.has(fieldName) &&
    currentValue !== undefined &&
    currentValue !== null &&
    currentValue !== ''
  )
    return false;
  return currentValue !== desiredValue;
}

export function mergeSelectOptions(existing = [], desired = [], { prune = false } = {}) {
  const desiredByName = new Map(desired.map((option) => [option.name, option]));
  const merged = desired.map((option) => {
    const current = existing.find((item) => optionName(item) === option.name);
    return current ? { ...option, id: current.id } : option;
  });
  if (!prune) {
    for (const option of existing)
      if (!desiredByName.has(optionName(option))) merged.push(normalizeSelectOption(option));
  }
  return merged;
}

export function optionName(option) {
  return typeof option.name === 'string' ? option.name : option.name?.raw;
}

export function normalizeSelectOption(option) {
  return {
    ...(option.id ? { id: option.id } : {}),
    name: optionName(option),
    color: option.color,
    description:
      typeof option.description === 'string' ? option.description : (option.description?.raw ?? ''),
  };
}

export function selectOptionsEqual(left = [], right = []) {
  const normalize = (options) =>
    options.map((option) => {
      const value = normalizeSelectOption(option);
      return {
        id: value.id ?? null,
        name: value.name,
        color: value.color,
        description: value.description ?? '',
      };
    });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function buildRulesetPayload(config, { activate = false, currentEnforcement = null } = {}) {
  const enforcement = activate ? 'active' : (currentEnforcement ?? 'disabled');
  return {
    name: config.name,
    target: config.target,
    enforcement,
    bypass_actors: [],
    conditions: { ref_name: { include: config.include, exclude: [] } },
    rules: [
      ...(config.blockDeletion ? [{ type: 'deletion' }] : []),
      ...(config.blockForcePush ? [{ type: 'non_fast_forward' }] : []),
      ...(config.requiredLinearHistory ? [{ type: 'required_linear_history' }] : []),
      {
        type: 'pull_request',
        parameters: {
          dismiss_stale_reviews_on_push: config.pullRequest.dismissStaleReviewsOnPush,
          require_code_owner_review: config.pullRequest.requireCodeOwnerReview,
          require_last_push_approval: config.pullRequest.requireLastPushApproval,
          required_approving_review_count: config.pullRequest.requiredApprovingReviewCount,
          required_review_thread_resolution: config.pullRequest.requiredReviewThreadResolution,
          allowed_merge_methods: config.pullRequest.allowedMergeMethods,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: true,
          required_status_checks: config.requiredStatusChecks.map((context) => ({ context })),
        },
      },
    ],
  };
}

export function repoSettingsPayload(settings) {
  return {
    allow_squash_merge: settings.allowSquashMerge,
    allow_rebase_merge: settings.allowRebaseMerge,
    allow_merge_commit: settings.allowMergeCommit,
    delete_branch_on_merge: settings.deleteBranchOnMerge,
  };
}

export function fieldValueUpdates(fieldsByName, currentValues, desiredValues, options = {}) {
  const updates = [];
  for (const [name, desired] of Object.entries(desiredValues)) {
    const field = fieldsByName.get(name);
    if (!field || desired === undefined || desired === null) continue;
    const current = currentValues?.[name];
    if (!shouldUpdateProjectValue(name, current, desired, options)) continue;
    if (String(field.data_type).toLowerCase() === 'single_select') {
      const option = field.options?.find((item) => optionName(item) === desired);
      if (!option) throw new Error(`Opção ${desired} ausente no field ${name}`);
      updates.push({ id: field.id, value: option.id });
    } else {
      updates.push({ id: field.id, value: desired });
    }
  }
  return updates;
}
