const XMLBuilder = require("xmlbuilder");
const uuid = require("uuid");
const bcrypt = require("bcrypt");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const log = require("./log.js");

const User = require("../model/user.js");
const Profile = require("../model/profiles.js");
const profileManager = require("../structs/profile.js");
const Friends = require("../model/friends.js");
const SaCCodes = require("../model/saccodes.js");
const Arena = require("../model/arena.js");
const playerStats = require("./userStats.js");

async function sleep(ms) {
  await new Promise((resolve, reject) => {
    setTimeout(resolve, ms);
  });
}

function GetVersionInfo(req) {
  let memory = {
    season: 0,
    build: 0.0,
    CL: "0",
    lobby: "",
  };

  if (req.headers["user-agent"]) {
    let CL = "";

    try {
      let BuildID = req.headers["user-agent"].split("-")[3].split(",")[0];

      if (!Number.isNaN(Number(BuildID))) CL = BuildID;
      else {
        BuildID = req.headers["user-agent"].split("-")[3].split(" ")[0];

        if (!Number.isNaN(Number(BuildID))) CL = BuildID;
      }
    } catch {
      try {
        let BuildID = req.headers["user-agent"].split("-")[1].split("+")[0];

        if (!Number.isNaN(Number(BuildID))) CL = BuildID;
      } catch { }
    }

    try {
      let Build = req.headers["user-agent"].split("Release-")[1].split("-")[0];

      if (Build.split(".").length == 3) {
        let Value = Build.split(".");
        Build = Value[0] + "." + Value[1] + Value[2];
      }

      memory.season = Number(Build.split(".")[0]);
      memory.build = Number(Build);
      memory.CL = CL;
      memory.lobby = `LobbySeason${memory.season}`;

      if (Number.isNaN(memory.season)) throw new Error();
    } catch {
      if (Number(memory.CL) < 3724489) {
        memory.season = 0;
        memory.build = 0.0;
        memory.CL = CL;
        memory.lobby = "LobbySeason0";
      } else if (Number(memory.CL) <= 3790078) {
        memory.season = 1;
        memory.build = 1.0;
        memory.CL = CL;
        memory.lobby = "LobbySeason1";
      } else {
        memory.season = 2;
        memory.build = 2.0;
        memory.CL = CL;
        memory.lobby = "LobbyWinterDecor";
      }
    }
  }

  return memory;
}

// Cache for content pages
let _contentPagesCache = null;
let _contentPagesResponseCache = new Map();

function getRequestLanguage(req) {
  let Language = "en";

  try {
    if (req.headers["accept-language"]) {
      if (
        req.headers["accept-language"].includes("-") &&
        req.headers["accept-language"] != "es-419"
      ) {
        Language = req.headers["accept-language"].split("-")[0];
      } else {
        Language = req.headers["accept-language"];
      }
    }
  } catch { }

  return Language;
}

function getContentPages(req) {
  const memory = GetVersionInfo(req);

  // Load contentpages only once
  if (!_contentPagesCache) {
    _contentPagesCache = JSON.parse(
      fs
        .readFileSync(
          path.join(__dirname, "..", "responses", "contentpages.json"),
        )
        .toString(),
    );
  }

  // Deep clone to avoid mutations
  const contentpages = JSON.parse(JSON.stringify(_contentPagesCache));

  let Language = getRequestLanguage(req);

  const modes = [
    "saveTheWorldUnowned",
    "battleRoyale",
    "creative",
    "saveTheWorld",
  ];
  const news = ["savetheworldnews", "battleroyalenews"];

  try {
    modes.forEach((mode) => {
      contentpages.subgameselectdata[mode].message.title =
        contentpages.subgameselectdata[mode].message.title[Language];
      contentpages.subgameselectdata[mode].message.body =
        contentpages.subgameselectdata[mode].message.body[Language];
    });
  } catch { }

  try {
    if (memory.build < 5.3) {
      news.forEach((mode) => {
        contentpages[mode].news.messages[0].image =
          "https://cdn.discordapp.com/attachments/927739901540188200/930879507496308736/discord.png";
        contentpages[mode].news.messages[1].image =
          "https://i.imgur.com/byYFCw2.png";
      });
    }
  } catch { }

  try {
    contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].stage = `season${memory.season}`;
    contentpages.dynamicbackgrounds.backgrounds.backgrounds[1].stage = `season${memory.season}`;

    if (memory.season == 10) {
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].stage =
        "seasonx";
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[1].stage =
        "seasonx";
    }

    if (memory.build == 11.31 || memory.build == 11.4) {
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].stage =
        "Winter19";
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[1].stage =
        "Winter19";
    }

    if (memory.build == 19.01) {
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].stage =
        "winter2021";
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
        "https://cdn.discordapp.com/attachments/927739901540188200/930880158167085116/t-bp19-lobby-xmas-2048x1024-f85d2684b4af.png";
      contentpages.subgameinfo.battleroyale.image =
        "https://cdn.discordapp.com/attachments/927739901540188200/930880421514846268/19br-wf-subgame-select-512x1024-16d8bb0f218f.jpg";
      contentpages.specialoffervideo.bSpecialOfferEnabled = "true";
    }

    if (memory.season == 20) {
      if (memory.build == 20.4) {
        contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
          "https://cdn2.unrealengine.com/t-bp20-40-armadillo-glowup-lobby-2048x2048-2048x2048-3b83b887cc7f.jpg";
      } else {
        contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
          "https://cdn2.unrealengine.com/t-bp20-lobby-2048x1024-d89eb522746c.png";
      }
    }

    if (memory.season == 21) {
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
        "https://cdn2.unrealengine.com/s21-lobby-background-2048x1024-2e7112b25dc3.jpg";

      if (memory.build == 21.1) {
        contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].stage =
          "season2100";
      }
      if (memory.build == 21.3) {
        contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
          "https://cdn2.unrealengine.com/nss-lobbybackground-2048x1024-f74a14565061.jpg";
        contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].stage =
          "season2130";
      }
    }

    if (memory.season == 22) {
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
        "https://cdn2.unrealengine.com/t-bp22-lobby-square-2048x2048-2048x2048-e4e90c6e8018.jpg";
    }

    if (memory.season == 23) {
      if (memory.build == 23.1) {
        contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
          "https://cdn2.unrealengine.com/t-bp23-winterfest-lobby-square-2048x2048-2048x2048-277a476e5ca6.png";
        contentpages.specialoffervideo.bSpecialOfferEnabled = "true";
      } else {
        contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
          "https://cdn2.unrealengine.com/t-bp20-lobby-2048x1024-d89eb522746c.png";
      }
    }

    if (memory.season == 24) {
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
        "https://cdn2.unrealengine.com/t-ch4s2-bp-lobby-4096x2048-edde08d15f7e.jpg";
    }

    if (memory.season == 25) {
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
        "https://cdn2.unrealengine.com/s25-lobby-4k-4096x2048-4a832928e11f.jpg";
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
        "https://cdn2.unrealengine.com/fn-shop-ch4s3-04-1920x1080-785ce1d90213.png";

      if (memory.build == 25.11) {
        contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].backgroundimage =
          "https://cdn2.unrealengine.com/t-s25-14dos-lobby-4096x2048-2be24969eee3.jpg";
      }
    }

    if (memory.season == 27) {
      contentpages.dynamicbackgrounds.backgrounds.backgrounds[0].stage =
        "rufus";
    }
  } catch { }

  return contentpages;
}

function getContentPagesResponse(req) {
  const memory = GetVersionInfo(req);
  const cacheKey = `${memory.season}:${memory.build}:${getRequestLanguage(req)}`;

  if (_contentPagesResponseCache.has(cacheKey)) {
    return _contentPagesResponseCache.get(cacheKey);
  }

  if (_contentPagesResponseCache.size > 50) {
    _contentPagesResponseCache.clear();
  }

  const body = JSON.stringify(getContentPages(req));
  _contentPagesResponseCache.set(cacheKey, body);
  return body;
}

// Cache for the item shop — rebuilt once per calendar day
let _itemShopCache = null;
let _itemShopCacheDate = "";
let _itemShopJsonCache = "";
let _offerIdCache = null;
let _battlePassCache = new Map();

function buildOfferIdCache(catalog) {
  const offers = new Map();

  for (const storefront of catalog?.storefronts || []) {
    for (const offer of storefront.catalogEntries || []) {
      if (!offer?.offerId) continue;
      offers.set(offer.offerId, {
        name: storefront.name,
        offerId: offer,
      });
    }
  }

  return offers;
}

function getItemShop() {
  // Use YYYY-MM-DD as cache key so it resets at midnight automatically
  const today = new Date().toISOString().slice(0, 10);
  if (_itemShopCache && _itemShopCacheDate === today) {
    return _itemShopCache;
  }

  let catalog;
  let CatalogConfig;

  try {
    catalog = JSON.parse(
      fs
        .readFileSync(path.join(__dirname, "..", "responses", "catalog.json"))
        .toString(),
    );
    CatalogConfig = JSON.parse(
      fs
        .readFileSync(
          path.join(__dirname, "..", "Config", "catalog_config.json"),
        )
        .toString(),
    );
  } catch (error) {
    log.error("Failed to read catalog files:", error);
    if (!catalog) {
      try {
        catalog = JSON.parse(
          fs
            .readFileSync(
              path.join(__dirname, "..", "responses", "catalog.json"),
            )
            .toString(),
        );
      } catch (e) {
        log.error("CRITICAL: Failed to read base catalog.json", e);
        return { storefronts: [] };
      }
    }
    CatalogConfig = {};
  }

  const todayAtMidnight = new Date();
  todayAtMidnight.setHours(24, 0, 0, 0);
  const todayOneMinuteBeforeMidnight = new Date(
    todayAtMidnight.getTime() - 60000,
  );
  const isoDate = todayOneMinuteBeforeMidnight.toISOString();

  try {
    for (let value in CatalogConfig) {
      if (!Array.isArray(CatalogConfig[value].itemGrants)) continue;
      if (CatalogConfig[value].itemGrants.length == 0) continue;

      const CatalogEntry = {
        devName: "",
        offerId: "",
        fulfillmentIds: [],
        dailyLimit: -1,
        weeklyLimit: -1,
        monthlyLimit: -1,
        categories: [],
        prices: [
          {
            currencyType: "MtxCurrency",
            currencySubType: "",
            regularPrice: 0,
            finalPrice: 0,
            saleExpiration: "9999-12-02T01:12:00Z",
            basePrice: 0,
          },
        ],
        meta: { SectionId: "Featured", TileSize: "Small" },
        matchFilter: "",
        filterWeight: 0,
        appStoreId: [],
        requirements: [],
        offerType: "StaticPrice",
        giftInfo: {
          bIsEnabled: true,
          forcedGiftBoxTemplateId: "",
          purchaseRequirements: [],
          giftRecordIds: [],
        },
        refundable: true,
        metaInfo: [
          { key: "SectionId", value: "Featured" },
          { key: "TileSize", value: "Small" },
        ],
        displayAssetPath: "",
        itemGrants: [],
        sortPriority: 0,
        catalogGroupPriority: 0,
      };

      let i = catalog.storefronts.findIndex(
        (p) =>
          p.name ==
          (value.toLowerCase().startsWith("daily")
            ? "BRDailyStorefront"
            : "BRWeeklyStorefront"),
      );
      if (i == -1) continue;

      if (value.toLowerCase().startsWith("daily")) {
        CatalogEntry.sortPriority = -1;
      } else {
        CatalogEntry.meta.TileSize = "Normal";
        CatalogEntry.metaInfo[1].value = "Normal";
      }

      for (let itemGrant of CatalogConfig[value].itemGrants) {
        if (typeof itemGrant != "string") continue;
        if (itemGrant.length == 0) continue;

        CatalogEntry.requirements.push({
          requirementType: "DenyOnItemOwnership",
          requiredId: itemGrant,
          minQuantity: 1,
        });
        CatalogEntry.itemGrants.push({ templateId: itemGrant, quantity: 1 });
      }

      CatalogEntry.prices = [
        {
          currencyType: "MtxCurrency",
          currencySubType: "",
          regularPrice: CatalogConfig[value].price,
          finalPrice: CatalogConfig[value].price,
          saleExpiration: isoDate,
          basePrice: CatalogConfig[value].price,
        },
      ];

      if (CatalogEntry.itemGrants.length > 0) {
        let uniqueIdentifier = crypto
          .createHash("sha1")
          .update(
            `${JSON.stringify(CatalogConfig[value].itemGrants)}_${CatalogConfig[value].price}`,
          )
          .digest("hex");

        CatalogEntry.devName = uniqueIdentifier;
        CatalogEntry.offerId = uniqueIdentifier;

        catalog.storefronts[i].catalogEntries.push(CatalogEntry);
      }
    }
  } catch { }

  _itemShopCache = catalog;
  _itemShopCacheDate = today;
  _itemShopJsonCache = JSON.stringify(catalog);
  _offerIdCache = buildOfferIdCache(catalog);
  return catalog;
}

function getItemShopResponse() {
  getItemShop();
  return _itemShopJsonCache || JSON.stringify(_itemShopCache || { storefronts: [] });
}

function invalidateItemShopCache() {
  _itemShopCache = null;
  _itemShopCacheDate = "";
  _itemShopJsonCache = "";
  _offerIdCache = null;
}

function getOfferID(offerId) {
  const catalog = getItemShop();

  if (!_offerIdCache) _offerIdCache = buildOfferIdCache(catalog);
  return _offerIdCache.get(offerId);
}

function getBattlePass(season) {
  const seasonNumber = Number(season);
  if (!Number.isFinite(seasonNumber)) return null;

  if (_battlePassCache.has(seasonNumber)) {
    return _battlePassCache.get(seasonNumber);
  }

  const battlePassFilePath = path.join(
    __dirname,
    "..",
    "responses",
    "Athena",
    "BattlePass",
    `Season${seasonNumber}.json`,
  );

  let battlePass = null;
  try {
    if (fs.existsSync(battlePassFilePath)) {
      battlePass = JSON.parse(fs.readFileSync(battlePassFilePath, "utf8"));
    }
  } catch (err) {
    log.debug(`Failed to load Battle Pass file for season ${seasonNumber}: ${err.message}`);
  }

  _battlePassCache.set(seasonNumber, battlePass);
  return battlePass;
}

function MakeID() {
  return uuid.v4();
}

function sendXmppMessageToAll(body) {
  if (!global.Clients) return;
  if (typeof body == "object") body = JSON.stringify(body);

  global.Clients.forEach((ClientData) => {
    ClientData.client.send(
      XMLBuilder.create("message")
        .attribute("from", `xmpp-admin@${global.xmppDomain}`)
        .attribute("xmlns", "jabber:client")
        .attribute("to", ClientData.jid)
        .element("body", `${body}`)
        .up()
        .toString(),
    );
  });
}

function sendXmppMessageToId(body, toAccountId) {
  if (!global.Clients) return;
  if (typeof body == "object") body = JSON.stringify(body);

  let receiver = global.Clients.find((i) => i.accountId == toAccountId);
  if (!receiver) return;

  receiver.client.send(
    XMLBuilder.create("message")
      .attribute("from", `xmpp-admin@${global.xmppDomain}`)
      .attribute("to", receiver.jid)
      .attribute("xmlns", "jabber:client")
      .element("body", `${body}`)
      .up()
      .toString(),
  );
}

function getPresenceFromUser(fromId, toId, offline) {
  if (!global.Clients) return;

  let SenderData = global.Clients.find((i) => i.accountId == fromId);
  let ClientData = global.Clients.find((i) => i.accountId == toId);

  if (!SenderData || !ClientData) return;

  let xml = XMLBuilder.create("presence")
    .attribute("to", ClientData.jid)
    .attribute("xmlns", "jabber:client")
    .attribute("from", SenderData.jid)
    .attribute("type", offline ? "unavailable" : "available");

  if (SenderData.lastPresenceUpdate.away)
    xml = xml
      .element("show", "away")
      .up()
      .element("status", SenderData.lastPresenceUpdate.status)
      .up();
  else xml = xml.element("status", SenderData.lastPresenceUpdate.status).up();

  ClientData.client.send(xml.toString());
}

async function registerUser(discordId, username, email, plainPassword) {
  email = email.toLowerCase();

  if (!username || !email || !plainPassword) {
    return {
      message: "Username, email, or password is required.",
      status: 400,
    };
  }

  if (discordId && (await User.findOne({ discordId }))) {
    return { message: "You already created an account!", status: 400 };
  }

  if (await User.findOne({ email })) {
    return { message: "Email is already in use.", status: 400 };
  }

  const accountId = MakeID().replace(/-/gi, "");
  const matchmakingId = MakeID().replace(/-/gi, "");

  const emailFilter =
    /^([a-zA-Z0-9_\.\-])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$/;
  if (!emailFilter.test(email)) {
    return {
      message: "You did not provide a valid email address.",
      status: 400,
    };
  }
  if (username.length >= 25) {
    return {
      message: "Your username must be less than 25 characters long.",
      status: 400,
    };
  }
  if (username.length < 3) {
    return {
      message: "Your username must be at least 3 characters long.",
      status: 400,
    };
  }
  if (plainPassword.length >= 128) {
    return {
      message: "Your password must be less than 128 characters long.",
      status: 400,
    };
  }
  if (plainPassword.length < 4) {
    return {
      message: "Your password must be at least 4 characters long.",
      status: 400,
    };
  }

  const allowedCharacters =
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~".split(
      "",
    );
  for (let character of username) {
    if (!allowedCharacters.includes(character)) {
      return {
        message:
          "Your username has special characters, please remove them and try again.",
        status: 400,
      };
    }
  }

  const hashedPassword = await bcrypt.hash(plainPassword, 10);

  try {
    await User.create({
      created: new Date().toISOString(),
      discordId: discordId || null,
      accountId,
      username,
      username_lower: username.toLowerCase(),
      email,
      password: hashedPassword,
      matchmakingId,
    }).then(async (i) => {
      await Profile.create({
        created: i.created,
        accountId: i.accountId,
        profiles: profileManager.createProfiles(i.accountId),
      });
      await Friends.create({ created: i.created, accountId: i.accountId });
      await Arena.create({ accountId: i.accountId, hype: 0, division: 0 });
      await playerStats.ensureUserStats(i.accountId);
    });
  } catch (err) {
    log.error("Error during user registration:", err);
    if (err.code == 11000) {
      return { message: `Username or email is already in use.`, status: 400 };
    }

    return {
      message: "An unknown error has occurred, please try again later.",
      status: 400,
    };
  }

  return {
    message: `Successfully created an account with the username **${username}**`,
    status: 200,
  };
}

async function createSAC(code, username, creator) {
  if (!code || !username)
    return {
      message: "**Code** or **Ingame Username** is required.",
      status: 400,
    };

  const account = await User.findOne({ username });

  if (account == null) return { message: `**${username}** doesnt exist!` };

  if (await SaCCodes.findOne({ code }))
    return { message: `**${code}** already exist!`, status: 400 };

  if (await SaCCodes.findOne({ owneraccountId: account.accountId }))
    return {
      message: `**${username}** already has an **Code** (**${code}**)!`,
      status: 400,
    };
  const creatorprofile = await User.findOne({ discordId: creator });

  const allowedCharacters =
    "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~".split(
      "",
    );
  for (let character of allowedCharacters) {
    if (!allowedCharacters.includes(character))
      return { message: "The Code has special Characters!", status: 400 };
  }

  try {
    await SaCCodes.create({
      created: new Date().toISOString(),
      createdby: creatorprofile.accountId,
      owneraccountId: account.accountId,
      code,
      code_lower: code.toLowerCase(),
      code_higher: code.toUpperCase(),
    });
  } catch (error) {
    return { message: error, status: 400 };
  }

  return {
    message: "You successfully created an **Support a Creator** Code!",
    status: 200,
  };
}

function DecodeBase64(str) {
  return Buffer.from(str, "base64").toString();
}

function UpdateTokens() {
  fs.writeFileSync(
    "./tokenManager/tokens.json",
    JSON.stringify(
      {
        accessTokens: global.accessTokens,
        refreshTokens: global.refreshTokens,
        clientTokens: global.clientTokens,
      },
      null,
      2,
    ),
  );
}

async function getDivisionPoints(accountId, statType) {
  const eventListPath = path.join(
    __dirname,
    "./../responses/eventlistactive.json",
  );
  const eventList = JSON.parse(fs.readFileSync(eventListPath, "utf-8"));
  const playerData = await Arena.findOne({ accountId });
  const playerDivision = playerData ? playerData.division : 0;

  const eventWindow = eventList.events[0].eventWindows.find(
    (window) => window.metadata.divisionRank === playerDivision,
  );

  if (!eventWindow) {
    log.error("Division non trouvée dans la liste des événements.");
    throw new Error("Division non trouvée dans la liste des événements.");
  }

  const scoringRule = eventList.templates
    .find(
      (template) => template.eventTemplateId === eventWindow.eventTemplateId,
    )
    .scoringRules.find((rule) => rule.trackedStat === statType);

  if (scoringRule) {
    const pointsEarned = scoringRule.rewardTiers[0].pointsEarned;
    return pointsEarned;
  }

  return 0;
}

async function addEliminationHypePoints(user) {
  const points = await getDivisionPoints(
    user.account_id,
    "TEAM_ELIMS_STAT_INDEX",
  );
  return await updateHypePoints(user, points);
}

// Optimized batch version for multiple kills
async function addEliminationHypePointsBatch(user, killCount) {
  const points = await getDivisionPoints(
    user.account_id,
    "TEAM_ELIMS_STAT_INDEX",
  );
  return await updateHypePoints(user, points * killCount);
}

async function addVictoryHypePoints(user) {
  const points = await getDivisionPoints(
    user.account_id,
    "PLACEMENT_STAT_INDEX",
  );
  return await updateHypePoints(user, points);
}

async function deductBusFareHypePoints(user) {
  const points = await getDivisionPoints(user.account_id, "MATCH_PLAYED_STAT");
  return await updateHypePoints(user, -points);
}

async function updateHypePoints(user, points) {
  const accountId = user.account_id || user.accountId;

  let playerData = await Arena.findOne({ accountId });
  let currentHype = playerData ? playerData.hype : 0;
  let currentDivision = playerData ? playerData.division : 0;

  currentHype += points;

  const nextDivision = getNextDivision(currentHype, currentDivision);
  currentDivision = nextDivision;

  await Arena.updateOne(
    { accountId },
    {
      $set: {
        accountId: accountId,
        hype: currentHype,
        division: currentDivision,
      },
    },
    { upsert: true },
  );

  return {
    success: true,
    data: `Points mis à jour à ${currentHype}, Division actuelle : ${currentDivision}`,
  };
}

function getNextDivision(hypePoints, currentDivision) {
  const thresholds = [
    400, 800, 1200, 2000, 3000, 5000, 7500, 10000, 14999, 15000,
  ];
  for (let i = 0; i < thresholds.length; i++) {
    if (hypePoints < thresholds[i]) return i;
  }
  return currentDivision;
}

function getAccountIdData(UserID) {
  const account_id = UserID ? UserID.split("|")[1] : "";

  return account_id;
}

function PlaylistNames(playlist) {
  switch (playlist) {
    case "2":
      return "Playlist_DefaultSolo";
    case "10":
      return "Playlist_DefaultDuo";
    case "9":
      return "Playlist_DefaultSquad";
    case "50":
      return "Playlist_50v50";
    case "11":
      return "Playlist_50v50";
    case "13":
      return "Playlist_HighExplosives_Squads";
    case "22":
      return "Playlist_5x20";
    case "36":
      return "Playlist_Blitz_Solo";
    case "37":
      return "Playlist_Blitz_Duos";
    case "19":
      return "Playlist_Blitz_Squad";
    case "33":
      return "Playlist_Carmine";
    case "32":
      return "Playlist_Fortnite";
    case "23":
      return "Playlist_HighExplosives_Solo";
    case "24":
      return "Playlist_HighExplosives_Squads";
    case "44":
      return "Playlist_Impact_Solo";
    case "45":
      return "Playlist_Impact_Duos";
    case "46":
      return "Playlist_Impact_Squads";
    case "35":
      return "Playlist_Playground";
    case "30":
      return "Playlist_SkySupply";
    case "42":
      return "Playlist_SkySupply_Duos";
    case "43":
      return "Playlist_SkySupply_Squads";
    case "41":
      return "Playlist_Snipers";
    case "39":
      return "Playlist_Snipers_Solo";
    case "40":
      return "Playlist_Snipers_Duos";
    case "26":
      return "Playlist_SolidGold_Solo";
    case "27":
      return "Playlist_SolidGold_Squads";
    case "28":
      return "Playlist_ShowdownAlt_Solo";
    case "solo":
      return "2";
    case "duo":
      return "10";
    case "squad":
      return "9";
    default:
      return playlist;
  }
}

function GeneratePassword(length) {
  const charset =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+";
  let retVal = "";
  for (let i = 0, n = charset.length; i < length; ++i) {
    retVal += charset.charAt(Math.floor(Math.random() * n));
  }
  return retVal;
}

function ParseDuration(duration) {
  const amount = parseInt(duration.slice(0, -1));
  const unit = duration.slice(-1).toLowerCase();

  if (isNaN(amount)) return null;

  const now = new Date();
  switch (unit) {
    case "h":
      return new Date(now.getTime() + amount * 60 * 60 * 1000);
    case "d":
      return new Date(now.getTime() + amount * 24 * 60 * 60 * 1000);
    case "w":
      return new Date(now.getTime() + amount * 7 * 24 * 60 * 60 * 1000);
    case "m":
      return new Date(now.getTime() + amount * 30 * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

async function mtxRewards(user, mtx, bUseXMPP) {
  const findProfile = await Profile.findOne({ accountId: user.accountId });

  if (findProfile) {
    const athena = findProfile.profiles["athena"];
    const common_core = findProfile.profiles["common_core"];

    if (athena && common_core) {
      common_core.items["Currency:MtxPurchased"].quantity += mtx;

      if (athena.stats.attributes.season_num >= 3) {
        if (common_core.items["MtxGive"] == undefined) {
          common_core.items["MtxGive"] = {
            templateId: `GiftBox:GB_MakeGood`,
            attributes: {
              lootList: [
                {
                  itemType: "Currency:MtxGiveaway",
                  itemGuid: "Currency:MtxGiveaway",
                  quantity: mtx,
                },
              ],
              params: {
                userMessage: `Vous avez gagné ${mtx} v-bucks durant votre partie.`,
              },
              giftedOn: new Date().toISOString(),
            },
            quantity: 1,
          };

          common_core.rvn++;
          common_core.commandRevision++;
          common_core.updated = new Date().toISOString();
        } else {
          const totalMtxWin =
            (common_core.items["MtxGive"].attributes.lootList[0].quantity +=
              mtx);
          common_core.items["MtxGive"].attributes.params.userMessage =
            `Vous avez gagné ${totalMtxWin} v-bucks durant votre partie.`;
        }
      }

      // Optimized: Only update the specific fields instead of the entire profile
      await Profile.updateOne(
        { accountId: user.accountId },
        {
          $set: {
            "profiles.common_core.items.Currency:MtxPurchased.quantity": common_core.items["Currency:MtxPurchased"].quantity,
            "profiles.common_core.items.MtxGive": common_core.items["MtxGive"],
            "profiles.common_core.rvn": common_core.rvn,
            "profiles.common_core.commandRevision": common_core.commandRevision,
            "profiles.common_core.updated": common_core.updated
          }
        }
      );

      if (bUseXMPP) {
        sendXmppMessageToId(
          {
            type: "com.epicgames.gift.received",
            payload: {},
            timestamp: new Date().toISOString(),
          },
          user.account_id,
        );
      }

      return {
        success: true,
        data: "Mtx successful give.",
      };
    } else
      return {
        success: false,
        data: "Profile not found.",
      };
  } else
    return {
      success: false,
      data: "Profile not found.",
    };
}

module.exports = {
  sleep,
  GetVersionInfo,
  getContentPages,
  getContentPagesResponse,
  getItemShop,
  getItemShopResponse,
  getOfferID,
  getBattlePass,
  invalidateItemShopCache,
  MakeID,
  sendXmppMessageToAll,
  sendXmppMessageToId,
  getPresenceFromUser,
  registerUser,
  createSAC,
  DecodeBase64,
  UpdateTokens,
  getAccountIdData,
  addEliminationHypePoints,
  addEliminationHypePointsBatch,
  addVictoryHypePoints,
  deductBusFareHypePoints,
  PlaylistNames,
  GeneratePassword,
  ParseDuration,
  mtxRewards,
};
