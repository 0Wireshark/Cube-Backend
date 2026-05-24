const defaultAthena = require("../Config/DefaultProfiles/athena.json");
const allAthena = require("../Config/DefaultProfiles/allathena.json");

const DEFAULT_LOADOUT_ID = "sandbox_loadout";
const DEFAULT_CHARACTER = "AthenaCharacter:CID_001_Athena_Commando_F_Default";

const SPECIAL_COSMETICS = new Set([
  "athenacharacter:cid_random",
  "athenabackpack:bid_random",
  "athenapickaxe:pickaxe_random",
  "athenaglider:glider_random",
  "athenaskydivecontrail:trails_random",
  "athenaitemwrap:wrap_random",
  "athenamusicpack:musicpack_random",
  "athenaloadingscreen:lsid_random",
]);

const DEFAULT_SLOT_ITEMS = {
  Character: [DEFAULT_CHARACTER],
  Backpack: [""],
  Pickaxe: ["AthenaPickaxe:DefaultPickaxe"],
  Glider: ["AthenaGlider:DefaultGlider"],
  SkyDiveContrail: [""],
  MusicPack: [""],
  LoadingScreen: [""],
  Dance: ["", "", "", "", "", ""],
  ItemWrap: ["", "", "", "", "", "", ""],
};

const DEFAULT_STAT_FAVORITES = {
  favorite_character: DEFAULT_CHARACTER,
  favorite_backpack: "",
  favorite_pickaxe: "",
  favorite_glider: "",
  favorite_skydivecontrail: "",
  favorite_musicpack: "",
  favorite_loadingscreen: "",
  favorite_dance: ["", "", "", "", "", ""],
  favorite_itemwraps: [],
};

const baseTemplateIds = new Set(
  Object.values(defaultAthena.items || {})
    .map((item) => normalizeId(item?.templateId))
    .filter(Boolean),
);
const allAthenaEntries = Object.entries(allAthena.items || {});
const allAthenaTemplateIndex = new Map();
const allAthenaCosmeticIdIndex = new Map();

for (const [key, item] of allAthenaEntries) {
  const normalizedKey = normalizeId(key);
  const normalizedTemplateId = normalizeId(item?.templateId);
  if (normalizedKey && !allAthenaTemplateIndex.has(normalizedKey)) {
    allAthenaTemplateIndex.set(normalizedKey, key);
  }
  if (normalizedTemplateId && !allAthenaTemplateIndex.has(normalizedTemplateId)) {
    allAthenaTemplateIndex.set(normalizedTemplateId, key);
  }

  const keyCosmeticId = normalizeId(key.split(":")[1]);
  const templateCosmeticId = normalizeId(item?.templateId?.split(":")[1]);
  if (keyCosmeticId && !allAthenaCosmeticIdIndex.has(keyCosmeticId)) {
    allAthenaCosmeticIdIndex.set(keyCosmeticId, key);
  }
  if (templateCosmeticId && !allAthenaCosmeticIdIndex.has(templateCosmeticId)) {
    allAthenaCosmeticIdIndex.set(templateCosmeticId, key);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeId(value) {
  return String(value || "").trim().toLowerCase();
}

function itemType(templateId) {
  return String(templateId || "").split(":")[0];
}

function isCosmeticLocker(itemId, item) {
  return (
    normalizeId(itemId).includes("loadout") ||
    normalizeId(item?.templateId) === "cosmeticlocker:cosmeticlocker_athena"
  );
}

function isBaseAthenaItem(itemId, item) {
  return Boolean(defaultAthena.items?.[itemId]) || baseTemplateIds.has(normalizeId(item?.templateId));
}

function createAthenaItem(templateId, sourceItem) {
  const item = sourceItem ? clone(sourceItem) : { templateId };
  item.templateId = item.templateId || templateId;
  item.attributes = item.attributes || {};

  if (normalizeId(item.templateId).startsWith("athena")) {
    if (item.attributes.max_level_bonus === undefined) item.attributes.max_level_bonus = 0;
    if (item.attributes.level === undefined) item.attributes.level = 1;
    if (item.attributes.item_seen === undefined) item.attributes.item_seen = false;
    if (item.attributes.xp === undefined) item.attributes.xp = 0;
    if (!Array.isArray(item.attributes.variants)) item.attributes.variants = [];
    if (item.attributes.favorite === undefined) item.attributes.favorite = false;
  }

  if (!Number.isFinite(item.quantity) || item.quantity < 1) item.quantity = 1;
  return item;
}

function findAllAthenaKeyByTemplateId(templateId) {
  const normalizedTemplateId = normalizeId(templateId);
  if (!normalizedTemplateId) return null;

  return allAthenaTemplateIndex.get(normalizedTemplateId) || null;
}

function findAllAthenaKeyByCosmeticId(cosmeticId) {
  const normalizedCosmeticId = normalizeId(cosmeticId);
  if (!normalizedCosmeticId) return null;

  return (
    allAthenaCosmeticIdIndex.get(normalizedCosmeticId) ||
    allAthenaEntries.find(([key]) => normalizeId(key).includes(normalizedCosmeticId))?.[0] ||
    null
  );
}

function getAllAthenaItem(key) {
  const item = allAthena.items?.[key];
  return item ? createAthenaItem(item.templateId || key, item) : null;
}

function getAllAthenaItems() {
  const items = {};
  for (const [itemId, item] of allAthenaEntries) {
    items[itemId] = createAthenaItem(item.templateId || itemId, item);
  }
  return items;
}

function mergeAthenaItems(athena, itemsById) {
  if (!athena.items || typeof athena.items !== "object") athena.items = {};

  let added = 0;
  for (const [itemId, item] of Object.entries(itemsById || {})) {
    if (!item?.templateId) continue;
    athena.items[itemId] = createAthenaItem(item.templateId, item);
    added++;
  }

  return added;
}

function ensureBaseAthenaItems(profile) {
  if (!profile.items || typeof profile.items !== "object") profile.items = {};

  let changed = false;
  for (const [itemId, item] of Object.entries(defaultAthena.items || {})) {
    if (!profile.items[itemId]) {
      profile.items[itemId] = clone(item);
      changed = true;
    }
  }

  return changed;
}

function getOwnedTemplateIds(items) {
  return new Set(
    Object.values(items || {})
      .map((item) => normalizeId(item?.templateId))
      .filter(Boolean),
  );
}

function isValidSlotValue(profile, ownedTemplateIds, value, category) {
  if (!value) return true;

  const normalizedValue = normalizeId(value);
  if (SPECIAL_COSMETICS.has(normalizedValue)) return true;

  const directItem = profile.items?.[value];
  const templateId = directItem?.templateId || value;
  if (itemType(templateId) !== `Athena${category}`) return false;

  return ownedTemplateIds.has(normalizeId(templateId));
}

function getDefaultSlotItems(category) {
  return clone(DEFAULT_SLOT_ITEMS[category] || [""]);
}

function getDefaultActiveVariants(category) {
  if (category === "Character" || category === "Backpack") return [{ variants: [] }];
  if (category === "Pickaxe") return [];
  if (category === "ItemWrap") return [null, null, null, null, null, null, null];
  if (category === "LoadingScreen" || category === "MusicPack" || category === "SkyDiveContrail") return [null];
  return undefined;
}

function sanitizeLoadout(profile, loadoutId, ownedTemplateIds, forceDefaults) {
  const loadout = profile.items?.[loadoutId];
  const slots = loadout?.attributes?.locker_slots_data?.slots;
  if (!slots) return false;

  let changed = false;
  for (const [category, defaultItems] of Object.entries(DEFAULT_SLOT_ITEMS)) {
    if (!slots[category]) {
      slots[category] = { items: clone(defaultItems) };
      changed = true;
    }

    const currentItems = Array.isArray(slots[category].items) ? slots[category].items : [];
    const shouldReset =
      forceDefaults ||
      currentItems.length !== defaultItems.length ||
      currentItems.some((value) => !isValidSlotValue(profile, ownedTemplateIds, value, category));

    if (shouldReset) {
      slots[category].items = getDefaultSlotItems(category);
      const activeVariants = getDefaultActiveVariants(category);
      if (activeVariants !== undefined) slots[category].activeVariants = activeVariants;
      changed = true;
    }
  }

  return changed;
}

function ensureStats(profile) {
  if (!profile.stats) profile.stats = {};
  if (!profile.stats.attributes) profile.stats.attributes = {};
  return profile.stats.attributes;
}

function resolveFavoriteValue(profile, value) {
  if (!value) return "";
  return profile.items?.[value]?.templateId || value;
}

function sanitizeFavorite(profile, ownedTemplateIds, attrName, category, defaultValue) {
  const attributes = ensureStats(profile);
  const value = attributes[attrName];

  if (Array.isArray(defaultValue)) {
    const current = Array.isArray(value) ? value : [];
    const sanitized = defaultValue.map((fallback, index) => {
      const entry = current[index] || "";
      return isValidSlotValue(profile, ownedTemplateIds, resolveFavoriteValue(profile, entry), category)
        ? entry
        : fallback;
    });

    if (JSON.stringify(value) !== JSON.stringify(sanitized)) {
      attributes[attrName] = sanitized;
      return true;
    }

    return false;
  }

  if (isValidSlotValue(profile, ownedTemplateIds, resolveFavoriteValue(profile, value), category)) {
    return false;
  }

  attributes[attrName] = defaultValue;
  return true;
}

function repairAthenaProfile(profile, options = {}) {
  if (!profile || typeof profile !== "object") return false;

  let changed = ensureBaseAthenaItems(profile);
  const attributes = ensureStats(profile);

  if (!Array.isArray(attributes.loadouts)) {
    attributes.loadouts = clone(defaultAthena.stats?.attributes?.loadouts || [DEFAULT_LOADOUT_ID]);
    changed = true;
  }

  if (!attributes.loadouts.includes(DEFAULT_LOADOUT_ID)) {
    attributes.loadouts.unshift(DEFAULT_LOADOUT_ID);
    changed = true;
  }

  attributes.loadouts = attributes.loadouts.filter((loadoutId) => {
    const keep = Boolean(profile.items?.[loadoutId]);
    if (!keep) changed = true;
    return keep;
  });

  if (attributes.loadouts.length === 0) {
    attributes.loadouts = [DEFAULT_LOADOUT_ID];
    changed = true;
  }

  if (
    !Number.isInteger(attributes.active_loadout_index) ||
    attributes.active_loadout_index < 0 ||
    attributes.active_loadout_index >= attributes.loadouts.length
  ) {
    attributes.active_loadout_index = 0;
    changed = true;
  }

  const activeLoadoutId = attributes.loadouts[attributes.active_loadout_index] || DEFAULT_LOADOUT_ID;
  if (attributes.last_applied_loadout !== activeLoadoutId) {
    attributes.last_applied_loadout = activeLoadoutId;
    changed = true;
  }

  const ownedTemplateIds = getOwnedTemplateIds(profile.items);
  for (const loadoutId of attributes.loadouts) {
    if (sanitizeLoadout(profile, loadoutId, ownedTemplateIds, options.forceDefaultLoadouts)) {
      changed = true;
    }
  }

  changed = sanitizeFavorite(profile, ownedTemplateIds, "favorite_character", "Character", DEFAULT_STAT_FAVORITES.favorite_character) || changed;
  changed = sanitizeFavorite(profile, ownedTemplateIds, "favorite_backpack", "Backpack", DEFAULT_STAT_FAVORITES.favorite_backpack) || changed;
  changed = sanitizeFavorite(profile, ownedTemplateIds, "favorite_pickaxe", "Pickaxe", DEFAULT_STAT_FAVORITES.favorite_pickaxe) || changed;
  changed = sanitizeFavorite(profile, ownedTemplateIds, "favorite_glider", "Glider", DEFAULT_STAT_FAVORITES.favorite_glider) || changed;
  changed = sanitizeFavorite(profile, ownedTemplateIds, "favorite_skydivecontrail", "SkyDiveContrail", DEFAULT_STAT_FAVORITES.favorite_skydivecontrail) || changed;
  changed = sanitizeFavorite(profile, ownedTemplateIds, "favorite_musicpack", "MusicPack", DEFAULT_STAT_FAVORITES.favorite_musicpack) || changed;
  changed = sanitizeFavorite(profile, ownedTemplateIds, "favorite_loadingscreen", "LoadingScreen", DEFAULT_STAT_FAVORITES.favorite_loadingscreen) || changed;
  changed = sanitizeFavorite(profile, ownedTemplateIds, "favorite_dance", "Dance", DEFAULT_STAT_FAVORITES.favorite_dance) || changed;
  changed = sanitizeFavorite(profile, ownedTemplateIds, "favorite_itemwraps", "ItemWrap", DEFAULT_STAT_FAVORITES.favorite_itemwraps) || changed;

  return changed;
}

function removeNonBaseAthenaItems(profile) {
  if (!profile.items || typeof profile.items !== "object") profile.items = {};

  const nextItems = {};
  let removed = 0;

  for (const [itemId, item] of Object.entries(profile.items)) {
    if (isBaseAthenaItem(itemId, item) || isCosmeticLocker(itemId, item)) {
      nextItems[itemId] = item;
    } else {
      removed++;
    }
  }

  profile.items = nextItems;
  repairAthenaProfile(profile, { forceDefaultLoadouts: true });

  return removed;
}

module.exports = {
  createAthenaItem,
  findAllAthenaKeyByCosmeticId,
  findAllAthenaKeyByTemplateId,
  getAllAthenaItems,
  getAllAthenaItem,
  isBaseAthenaItem,
  mergeAthenaItems,
  removeNonBaseAthenaItems,
  repairAthenaProfile,
};
