const { MessageEmbed } = require("discord.js");
const Users = require("../../../model/user.js");
const Profiles = require("../../../model/profiles.js");
const log = require("../../../structs/log.js");
const config = require("../../../Config/config.json");
const uuid = require("uuid");
const athenaInventory = require("../../../structs/athenaInventory.js");
const profileRefresh = require("../../../structs/profileRefresh.js");
const { UNIFIED_PURPLE } = require("../../utils/embedTheme.js");

const COSMETIC_COMPATIBILITY_CACHE_MS = 60 * 60 * 1000;
let cosmeticCompatibilityCache = null;

function bumpProfileRevision(profile) {
    profile.rvn = (profile.rvn || 0) + 1;
    profile.commandRevision = (profile.commandRevision || 0) + 1;
    profile.updated = new Date().toISOString();
}

function getPackItems(templateIds) {
    const items = {};
    const missing = [];

    for (const templateId of templateIds) {
        const itemId = athenaInventory.findAllAthenaKeyByTemplateId(templateId);
        const item = itemId ? athenaInventory.getAllAthenaItem(itemId) : null;

        if (itemId && item) {
            items[itemId] = item;
        } else {
            missing.push(templateId);
        }
    }

    return { items, missing };
}

function getCosmeticLoadouts(items) {
    const loadouts = {};

    for (const [itemId, item] of Object.entries(items || {})) {
        if (itemId.includes("loadout") || item?.templateId?.startsWith("CosmeticLocker:")) {
            loadouts[itemId] = item;
        }
    }

    return loadouts;
}

function parseIntroSeason(value) {
    const season = String(value || "").trim().toUpperCase();
    if (season === "X") return 10;

    const parsed = Number.parseInt(season, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function getConfiguredMaxIntro() {
    if (!config.bEnableOnlyOneVersionJoinable) return null;

    const build = Number(config.bVersionJoinable);
    if (!Number.isFinite(build)) return null;

    const major = Math.floor(build);
    if (major <= 10) return { chapter: 1, season: major === 10 ? 10 : major };
    if (major <= 18) return { chapter: 2, season: major - 10 };
    if (major <= 22) return { chapter: 3, season: major - 18 };
    if (major <= 26) return { chapter: 4, season: major - 22 };

    return null;
}

function getConfiguredClientVersionLabel() {
    const version = Number(config.bVersionJoinable);
    return Number.isFinite(version) ? version.toFixed(2) : String(config.bVersionJoinable || "unknown");
}

function getCosmeticCompatibility(cosmetic) {
    const maxIntro = getConfiguredMaxIntro();
    if (!maxIntro) return { compatible: true };

    const introduction = cosmetic?.introduction;
    const chapter = Number.parseInt(introduction?.chapter, 10);
    const season = parseIntroSeason(introduction?.season);

    if (!Number.isFinite(chapter) || !Number.isFinite(season)) {
        return { compatible: true };
    }

    const compatible =
        chapter < maxIntro.chapter ||
        (chapter === maxIntro.chapter && season <= maxIntro.season);

    return {
        compatible,
        itemIntro: { chapter, season },
        maxIntro
    };
}

async function getCosmeticCompatibilityMap() {
    const maxIntro = getConfiguredMaxIntro();
    if (!maxIntro) return null;

    if (cosmeticCompatibilityCache && cosmeticCompatibilityCache.expiresAt > Date.now()) {
        return cosmeticCompatibilityCache.map;
    }

    try {
        const response = await fetch("https://fortnite-api.com/v2/cosmetics/br?language=en");
        const json = await response.json();
        if (json.status !== 200 || !Array.isArray(json.data)) return null;

        const map = new Map();
        for (const cosmetic of json.data) {
            map.set(String(cosmetic.id || "").toLowerCase(), getCosmeticCompatibility(cosmetic).compatible);
        }

        cosmeticCompatibilityCache = {
            expiresAt: Date.now() + COSMETIC_COMPATIBILITY_CACHE_MS,
            map,
        };

        return map;
    } catch (error) {
        log.error("Failed to fetch cosmetic compatibility list", error);
        return null;
    }
}

async function filterItemsForConfiguredClient(items) {
    const compatibilityMap = await getCosmeticCompatibilityMap();
    if (!compatibilityMap) return { items, skipped: 0 };

    const filtered = {};
    let skipped = 0;

    for (const [itemId, item] of Object.entries(items || {})) {
        const templateId = item?.templateId || itemId;
        const normalizedTemplateId = templateId.toLowerCase();

        if (
            athenaInventory.isBaseAthenaItem(itemId, item) ||
            normalizedTemplateId === "cosmeticlocker:cosmeticlocker_athena"
        ) {
            filtered[itemId] = item;
            continue;
        }

        if (!normalizedTemplateId.startsWith("athena") || !templateId.includes(":")) {
            skipped++;
            continue;
        }

        const cosmeticId = templateId.split(":")[1].toLowerCase();
        if (compatibilityMap.get(cosmeticId)) {
            filtered[itemId] = item;
        } else {
            skipped++;
        }
    }

    return { items: filtered, skipped };
}

module.exports = {
    commandInfo: {
        name: "give",
        description: "give a user specific cosmetic packs or Vbucks",
        options: [
            {
                name: "pack",
                description: "The pack or currency you want to give",
                required: true,
                type: 3,
                choices: [
                    { name: "Full Locker", value: "full" },
                    { name: "Tuff Pack", value: "tuff" },
                    { name: "Summer Pack", value: "summer" },
                    { name: "Basic Donator", value: "basicdonator" },
                    { name: "VBucks", value: "vbucks" },
                    { name: "Item", value: "item" }
                ]
            },
            {
                name: "user",
                description: "give pack to",
                required: true,
                type: 6
            },
            {
                name: "amount",
                description: "The amount of V-Bucks to give",
                required: false,
                type: 4
            },
            {
                name: "itemname",
                description: "The name of the item to give",
                required: false,
                type: 3
            }
        ]
    },
    execute: async (interaction) => {
        if (!config.moderators.includes(interaction.user.id)) {
            return interaction.reply({ content: "You do not have moderator permissions.", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const pack = interaction.options.getString("pack");
        const selectedUser = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        const itemname = interaction.options.getString("itemname");
        const selectedUserId = selectedUser?.id;

        try {
            const targetUser = await Users.findOne({ discordId: selectedUserId });
            if (!targetUser) {
                return interaction.editReply({ content: "That user does not own an account" });
            }

            const profile = await Profiles.findOne({ accountId: targetUser.accountId });
            if (!profile) {
                return interaction.editReply({ content: "That user does not have a profile" });
            }

            if (pack === "item") {
                if (!itemname) {
                    return interaction.editReply({ content: "Please provide an item name." });
                }

                const response = await fetch(`https://fortnite-api.com/v2/cosmetics/br/search?name=${encodeURIComponent(itemname)}`);
                const json = await response.json();

                if (json.status !== 200 || !json.data) {
                    return interaction.editReply({ content: `Could not find the item "${itemname}".` });
                }

                const itemData = json.data;
                const compatibility = getCosmeticCompatibility(itemData);
                if (!compatibility.compatible) {
                    return interaction.editReply({
                        content: `Cannot give "${itemData.name}" on client ${getConfiguredClientVersionLabel()}: this cosmetic is from Chapter ${compatibility.itemIntro.chapter} Season ${compatibility.itemIntro.season}, while this backend is locked to Chapter ${compatibility.maxIntro.chapter} Season ${compatibility.maxIntro.season}. Unsupported cosmetics are what make equip load forever.`
                    });
                }

                const foundKey = athenaInventory.findAllAthenaKeyByCosmeticId(itemData.id);

                if (!foundKey) {
                    return interaction.editReply({ content: `Item "${itemData.name}" found on API but not in backend database.` });
                }

                const cosmetic = athenaInventory.getAllAthenaItem(foundKey);
                const athena = profile.profiles.athena;
                const common_core = profile.profiles.common_core;

                if (!athena.items) athena.items = {};
                if (!common_core.items) common_core.items = {};

                athena.items[foundKey] = cosmetic;

                const purchaseId = uuid.v4();
                common_core.items[purchaseId] = {
                    templateId: "GiftBox:GB_MakeGood",
                    attributes: {
                        fromAccountId: "[Administrator]",
                        lootList: [{
                            itemType: cosmetic.templateId,
                            itemGuid: foundKey,
                            itemProfile: "athena",
                            quantity: 1
                        }],
                        params: {
                            userMessage: `Gifted ${itemData.name} from CUBE!`
                        },
                        giftedOn: new Date().toISOString()
                    },
                    quantity: 1
                };

                athenaInventory.repairAthenaProfile(athena);
                bumpProfileRevision(common_core);
                bumpProfileRevision(athena);

                await Profiles.updateOne(
                    { accountId: targetUser.accountId },
                    { $set: { "profiles.athena": athena, "profiles.common_core": common_core } }
                );
                profileRefresh.queueGiftRefresh(targetUser.accountId);

                const embed = new MessageEmbed()
                    .setTitle("Item Granted")
                    .setDescription(`Successfully gave **${itemData.name}** to **${selectedUser.username}** via GiftBox.`)
                    .setThumbnail(itemData.images.icon)
                    .setColor(UNIFIED_PURPLE)
                    .setFooter({ text: "CUBE", iconURL: "https://i.imgur.com/JKe2JcI.png" })
                    .setTimestamp();

                try {
                    await selectedUser.send({
                        embeds: [
                            new MessageEmbed()
                                .setTitle("Gift Received")
                                .setDescription(`You have received **${itemData.name}** via GiftBox from CUBE!`)
                                .setThumbnail(itemData.images.icon)
                                .setColor(UNIFIED_PURPLE)
                                .setFooter({ text: "CUBE", iconURL: "https://i.imgur.com/JKe2JcI.png" })
                                .setTimestamp()
                        ]
                    });
                } catch (e) {
                    log.error("Failed to send DM to user", e);
                }

                return await interaction.editReply({ embeds: [embed] });
            }

            if (pack === "vbucks") {
                if (!amount || amount <= 0) {
                    return interaction.editReply({ content: "Please provide a valid V-Bucks amount." });
                }

                const common_core = profile.profiles.common_core;
                const profile0 = profile.profiles.profile0;

                if (!common_core.items) common_core.items = {};
                if (!profile0.items) profile0.items = {};

                if (!common_core.items["Currency:MtxPurchased"]) {
                    common_core.items["Currency:MtxPurchased"] = { templateId: "Currency:MtxPurchased", quantity: 0, attributes: {} };
                }
                if (!profile0.items["Currency:MtxPurchased"]) {
                    profile0.items["Currency:MtxPurchased"] = { templateId: "Currency:MtxPurchased", quantity: 0, attributes: {} };
                }

                common_core.items["Currency:MtxPurchased"].quantity += amount;
                profile0.items["Currency:MtxPurchased"].quantity += amount;

                const purchaseId = uuid.v4();
                common_core.items[purchaseId] = {
                    templateId: "GiftBox:GB_MakeGood",
                    attributes: {
                        fromAccountId: "[Administrator]",
                        lootList: [{
                            itemType: "Currency:MtxGiveaway",
                            itemGuid: "Currency:MtxGiveaway",
                            quantity: amount
                        }],
                        params: {
                            userMessage: "Gifted V-Bucks from CUBE!"
                        },
                        giftedOn: new Date().toISOString()
                    },
                    quantity: 1
                };

                bumpProfileRevision(common_core);
                bumpProfileRevision(profile0);

                await Profiles.updateOne(
                    { accountId: targetUser.accountId },
                    {
                        $set: {
                            "profiles.common_core": common_core,
                            "profiles.profile0": profile0
                        }
                    }
                );
                profileRefresh.queueGiftRefresh(targetUser.accountId);

                const embed = new MessageEmbed()
                    .setTitle("V-Bucks Added")
                    .setDescription(`Successfully added **${amount.toLocaleString()}** V-Bucks to **${selectedUser.username}**'s account.`)
                    .setThumbnail("https://i.imgur.com/JKe2JcI.png")
                    .setColor(UNIFIED_PURPLE)
                    .setFooter({
                        text: "CUBE",
                        iconURL: "https://i.imgur.com/JKe2JcI.png"
                    })
                    .setTimestamp();

                try {
                    await selectedUser.send({
                        embeds: [
                            new MessageEmbed()
                                .setTitle("V-Bucks Received")
                                .setDescription(`You have received **${amount.toLocaleString()}** V-Bucks from CUBE!`)
                                .setThumbnail("https://i.imgur.com/JKe2JcI.png")
                                .setColor(UNIFIED_PURPLE)
                                .setFooter({ text: "CUBE", iconURL: "https://i.imgur.com/JKe2JcI.png" })
                                .setTimestamp()
                        ]
                    });
                } catch (e) {
                    log.error("Failed to send DM to user", e);
                }

                return await interaction.editReply({ embeds: [embed] });
            }

            let itemsToGive = {};
            let missingItems = [];
            let skippedUnsupportedItems = 0;
            const athena = profile.profiles.athena;
            if (!athena.items) athena.items = {};

            if (pack === "full") {
                const filteredItems = await filterItemsForConfiguredClient(athenaInventory.getAllAthenaItems());
                itemsToGive = filteredItems.items;
                skippedUnsupportedItems = filteredItems.skipped;
                const loadouts = getCosmeticLoadouts(athena.items);
                itemsToGive = { ...itemsToGive, ...loadouts };
            } else if (pack === "tuff") {
                const tuffIds = [
                    "AthenaCharacter:CID_175_Athena_Commando_M_Celestial",
                    "AthenaCharacter:CID_757_Athena_Commando_F_WildCat",
                    "AthenaCharacter:CID_703_Athena_Commando_M_Cyclone",
                    "AthenaCharacter:CID_479_Athena_Commando_F_Davinci",
                    "AthenaCharacter:CID_434_Athena_Commando_F_StealthHonor",
                    "AthenaCharacter:CID_028_Athena_Commando_F",
                    "AthenaCharacter:CID_017_Athena_Commando_M",
                    "AthenaCharacter:CID_030_Athena_Commando_M_Halloween",
                    "AthenaCharacter:CID_029_Athena_Commando_F_Halloween",
                    "AthenaPickaxe:Pickaxe_ID_376_FNCS",
                    "AthenaPickaxe:Pickaxe_ID_294_CandyCane",
                    "AthenaGlider:Glider_Warthog",
                    "AthenaGlider:Glider_ID_196_CycloneMale",
                    "AthenaDance:EID_Floss",
                    "AthenaDance:EID_TakeTheL",
                    "AthenaDance:EID_Jaywalking",
                    "AthenaDance:EID_Hype",
                    "AthenaDance:EID_CycloneHeadBang",
                    "AthenaDance:EID_GoodVibes"
                ];

                const packItems = getPackItems(tuffIds);
                const filteredItems = await filterItemsForConfiguredClient(packItems.items);
                itemsToGive = { ...athena.items, ...filteredItems.items };
                missingItems = packItems.missing;
                skippedUnsupportedItems = filteredItems.skipped;
            } else if (pack === "summer") {
                const summerIds = [
                    "AthenaCharacter:CID_A_131_Athena_Commando_F_JurassicArchaeologySummer",
                    "AthenaCharacter:CID_A_127_Athena_Commando_F_MechanicalEngineerSummer",
                    "AthenaCharacter:CID_805_Athena_Commando_F_PunkDevilSummer",
                    "AthenaCharacter:CID_A_114_Athena_Commando_F_Believer",
                    "AthenaCharacter:CID_A_117_Athena_Commando_F_Rockstar",
                    "AthenaPickaxe:Pickaxe_ID_014_WinterCamo",
                    "AthenaDance:EID_CelebrationDance",
                    "AthenaGlider:Umbrella_Season_05"
                ];

                const packItems = getPackItems(summerIds);
                const filteredItems = await filterItemsForConfiguredClient(packItems.items);
                itemsToGive = { ...athena.items, ...filteredItems.items };
                missingItems = packItems.missing;
                skippedUnsupportedItems = filteredItems.skipped;
            } else if (pack === "basicdonator") {
                const basicDonatorIds = [
                    "AthenaCharacter:CID_A_215_Athena_Commando_F_SunriseCastle_48TIZ",
                    "AthenaCharacter:CID_A_202_Athena_Commando_F_Division",
                    "AthenaCharacter:CID_732_Athena_Commando_F_Stars",
                    "AthenaCharacter:CID_976_Athena_Commando_F_Wombat_0GRTQ",
                    "AthenaCharacter:CID_828_Athena_Commando_F_Valet",
                    "AthenaCharacter:CID_530_Athena_Commando_F_BlackMonday_1BV6J",
                    "AthenaCharacter:CID_061_Athena_Commando_F_SkiGirl",
                    "AthenaCharacter:CID_625_Athena_Commando_F_PinkTrooper",
                    "AthenaCharacter:CID_A_205_Athena_Commando_F_TextileRam_GMRJ0",
                    "AthenaPickaxe:Pickaxe_ID_508_HistorianMale_6BQSW",
                    "AthenaPickaxe:Pickaxe_ID_190_GolfClub",
                    "AthenaPickaxe:Pickaxe_ID_179_StarWand",
                    "AthenaPickaxe:Pickaxe_ID_599_CavernFemale",
                    "AthenaGlider:Glider_ID_238_Soy_RWO5D",
                    "AthenaDance:EID_Griddles"
                ];

                const packItems = getPackItems(basicDonatorIds);
                const filteredItems = await filterItemsForConfiguredClient(packItems.items);
                itemsToGive = { ...athena.items, ...filteredItems.items };
                missingItems = packItems.missing;
                skippedUnsupportedItems = filteredItems.skipped;
            }  

            if (missingItems.length > 0) {
                log.debug(`Give command skipped ${missingItems.length} missing pack item(s): ${missingItems.join(", ")}`);
            }
            if (skippedUnsupportedItems > 0) {
                log.debug(`Give command skipped ${skippedUnsupportedItems} unsupported item(s) for client ${getConfiguredClientVersionLabel()}`);
            }

            athena.items = itemsToGive;
            athenaInventory.repairAthenaProfile(athena);
            bumpProfileRevision(athena);

            await Profiles.updateOne(
                { accountId: targetUser.accountId },
                {
                    $set: { "profiles.athena": athena }
                }
            );
            profileRefresh.queueGiftRefresh(targetUser.accountId);

            let packName = pack === "full" ? "Full Locker" : pack === "tuff" ? "Tuff Pack" : pack === "summer" ? "Summer Pack" : "Basic Donator";
            const skippedText = skippedUnsupportedItems > 0
                ? `\nSkipped **${skippedUnsupportedItems}** unsupported item(s) for client ${getConfiguredClientVersionLabel()}.`
                : "";
            const embed = new MessageEmbed()
                .setTitle(`${packName} Added`)
                .setDescription(`Successfully added the **${packName}** to **${selectedUser.username}**'s account.${skippedText}`)
                .setColor(UNIFIED_PURPLE)
                .setFooter({
                    text: "CUBE",
                    iconURL: "https://i.imgur.com/JKe2JcI.png"
                })
                .setTimestamp();

            try {
                await selectedUser.send({
                    embeds: [
                        new MessageEmbed()
                            .setTitle(`${packName} Received`)
                            .setDescription(`You have received the **${packName}** from CUBE!`)
                            .setColor(UNIFIED_PURPLE)
                            .setFooter({ text: "CUBE", iconURL: "https://i.imgur.com/JKe2JcI.png" })
                            .setTimestamp()
                    ]
                });
            } catch (e) {
                log.error("Failed to send DM to user", e);
            }

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            log.error("An error occurred:", error);
            interaction.editReply({ content: "An error occurred while processing the request." });
        }
    }
};
