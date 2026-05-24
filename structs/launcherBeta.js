function getLauncherBetaConfig(config) {
  const betaConfig = config?.launcherBeta;
  return betaConfig && typeof betaConfig === "object" ? betaConfig : {};
}

function parseBetaDate(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) return null;

  const parsedDate = new Date(rawValue);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function getBetaTimeZone(config) {
  const configuredTimeZone = String(getLauncherBetaConfig(config).timeZone || "").trim();
  return configuredTimeZone || "UTC";
}

function formatBetaDate(config, value) {
  const parsedDate = value instanceof Date ? value : parseBetaDate(value);
  if (!parsedDate) return "";

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: getBetaTimeZone(config),
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(parsedDate);
  } catch (_error) {
    return parsedDate.toISOString();
  }
}

function buildBeforeStartMessage(config, startAt) {
  const formattedStart = formatBetaDate(config, startAt);
  return formattedStart
    ? `The beta starts at ${formattedStart}.`
    : "The beta has not started yet.";
}

function buildRoleRequiredMessage() {
  return "You are not a beta tester.";
}

function getBetaState(config, now = new Date()) {
  const betaConfig = getLauncherBetaConfig(config);
  const enabled = betaConfig.enable === true;
  const requiredRoleId = String(betaConfig.requiredRoleId || "").trim();
  const startAt = parseBetaDate(betaConfig.startAt);
  const endAt = parseBetaDate(betaConfig.endAt);
  const hasRoleGate = enabled && Boolean(requiredRoleId);
  const normalizedNow = now instanceof Date ? now : new Date(now);

  if (!enabled || !startAt || !endAt || endAt <= startAt) {
    return {
      enabled: false,
      stage: "disabled",
      requiredRoleId,
      startsAt: startAt ? startAt.toISOString() : "",
      endsAt: endAt ? endAt.toISOString() : "",
      startsAtLabel: formatBetaDate(config, startAt),
      endsAtLabel: formatBetaDate(config, endAt),
      requiresBetaRole: false,
      launchAllowedWithoutRole: true,
      message: ""
    };
  }

  if (normalizedNow < startAt) {
    return {
      enabled: true,
      stage: "before",
      requiredRoleId,
      startsAt: startAt.toISOString(),
      endsAt: endAt.toISOString(),
      startsAtLabel: formatBetaDate(config, startAt),
      endsAtLabel: formatBetaDate(config, endAt),
      requiresBetaRole: hasRoleGate,
      launchAllowedWithoutRole: false,
      message: buildBeforeStartMessage(config, startAt)
    };
  }

  if (normalizedNow < endAt) {
    return {
      enabled: true,
      stage: "restricted",
      requiredRoleId,
      startsAt: startAt.toISOString(),
      endsAt: endAt.toISOString(),
      startsAtLabel: formatBetaDate(config, startAt),
      endsAtLabel: formatBetaDate(config, endAt),
      requiresBetaRole: hasRoleGate,
      launchAllowedWithoutRole: !hasRoleGate,
      message: hasRoleGate ? buildRoleRequiredMessage() : ""
    };
  }

  return {
    enabled: true,
    stage: "open",
    requiredRoleId,
    startsAt: startAt.toISOString(),
    endsAt: endAt.toISOString(),
    startsAtLabel: formatBetaDate(config, startAt),
    endsAtLabel: formatBetaDate(config, endAt),
    requiresBetaRole: false,
    launchAllowedWithoutRole: true,
    message: ""
  };
}

function isOwner(config, roles) {
  const ownerRoleId = String(config?.launcherBeta?.ownerRoleId || "").trim();
  if (!ownerRoleId) return false;
  return Array.isArray(roles) && roles.some((role) => String(role?.id || "").trim() === ownerRoleId);
}

function hasRequiredBetaRole(roles, requiredRoleId) {
  const normalizedRequiredRoleId = String(requiredRoleId || "").trim();
  if (!normalizedRequiredRoleId) return true;

  return Array.isArray(roles) && roles.some((role) => String(role?.id || "").trim() === normalizedRequiredRoleId);
}

function ensureBetaAccess(config, roles, now = new Date()) {
  // Owners bypass all beta restrictions unconditionally
  if (isOwner(config, roles)) {
    return { allowed: true, beta: getBetaState(config, now), isOwner: true };
  }

  const beta = getBetaState(config, now);
  if (!beta.enabled) {
    return { allowed: true, beta };
  }

  if (beta.stage === "before") {
    return {
      allowed: false,
      beta,
      statusCode: 403,
      error: beta.message || "The beta has not started yet."
    };
  }

  if (beta.stage === "restricted" && beta.requiresBetaRole && !hasRequiredBetaRole(roles, beta.requiredRoleId)) {
    return {
      allowed: false,
      beta,
      statusCode: 403,
      error: buildRoleRequiredMessage()
    };
  }

  return { allowed: true, beta };
}

module.exports = {
  ensureBetaAccess,
  formatBetaDate,
  getBetaState
};
