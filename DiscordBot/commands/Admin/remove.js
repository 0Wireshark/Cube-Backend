const { MessageEmbed } = require("discord.js");
const Users = require("../../../model/user.js");
const Profiles = require("../../../model/profiles.js");
const config = require("../../../Config/config.json");
const log = require("../../../structs/log.js");
const athenaInventory = require("../../../structs/athenaInventory.js");
const profileRefresh = require("../../../structs/profileRefresh.js");
const { UNIFIED_PURPLE } = require("../../utils/embedTheme.js");

function bumpProfileRevision(profile) {
    profile.rvn = (profile.rvn || 0) + 1;
    profile.commandRevision = (profile.commandRevision || 0) + 1;
    profile.updated = new Date().toISOString();
}

function removeItemsByTemplateIds(athena, templateIds) {
    const templateIdSet = new Set(templateIds.map((templateId) => templateId.toLowerCase()));
    let removed = 0;

    for (const [itemId, item] of Object.entries(athena.items || {})) {
        if (!item?.templateId) continue;
        if (!templateIdSet.has(item.templateId.toLowerCase())) continue;
        if (athenaInventory.isBaseAthenaItem(itemId, item)) continue;

        delete athena.items[itemId];
        removed++;
    }

    return removed;
}

async function saveAthenaProfile(accountId, athena) {
    athenaInventory.repairAthenaProfile(athena);
    bumpProfileRevision(athena);

    await Profiles.updateOne(
        { accountId },
        { $set: { "profiles.athena": athena } }
    );

    profileRefresh.queueAthenaRefresh(accountId);
}

module.exports = {
    commandInfo: {
        name: "remove",
        description: "Allows you to remove items from a user's locker.",
        options: [
            {
                name: "type",
                description: "What to remove",
                required: true,
                type: 3,
                choices: [
                    { name: "Full Locker", value: "all" },
                    { name: "Tuff Pack", value: "tuff" },
                    { name: "Summer Pack", value: "summer" },
                    { name: "Basic Donator", value: "basicdonator" },
                    { name: "Single Item", value: "item" }
                ]
            },
            {
                name: "user",
                description: "The user to remove items from",
                required: true,
                type: 6
            },
            {
                name: "itemname",
                description: "The name of the item to remove (required if Single Item is selected)",
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

        const type = interaction.options.getString("type");
        const selectedUser = interaction.options.getUser("user");
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

            const athena = profile.profiles.athena;
            if (!athena.items) athena.items = {};

            if (type === "all") {
                const removed = athenaInventory.removeNonBaseAthenaItems(athena);
                await saveAthenaProfile(targetUser.accountId, athena);

                const embed = new MessageEmbed()
                    .setTitle("Full Locker Removed")
                    .setDescription(`Successfully removed **${removed}** non-base item(s) from **${selectedUser.username}**'s account.`)
                    .setColor(UNIFIED_PURPLE)
                    .setFooter({ text: "CUBE", iconURL: "https://i.imgur.com/JKe2JcI.png" })
                    .setTimestamp();

                return await interaction.editReply({ embeds: [embed] });
            }

            if (type === "tuff" || type === "summer" || type === "basicdonator") {
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

                const itemsToRemove = type === "tuff" ? tuffIds : type === "summer" ? summerIds : basicDonatorIds;
                const packName = type === "tuff" ? "Tuff Pack" : type === "summer" ? "Summer Pack" : "Basic Donator";
                const removed = removeItemsByTemplateIds(athena, itemsToRemove);
                await saveAthenaProfile(targetUser.accountId, athena);

                const embed = new MessageEmbed()
                    .setTitle(`${packName} Removed`)
                    .setDescription(`Successfully removed **${removed}** item(s) from the **${packName}** on **${selectedUser.username}**'s account.`)
                    .setColor(UNIFIED_PURPLE)
                    .setFooter({ text: "CUBE", iconURL: "https://i.imgur.com/JKe2JcI.png" })
                    .setTimestamp();

                return await interaction.editReply({ embeds: [embed] });
            }

            if (type === "item") {
                if (!itemname) {
                    return interaction.editReply({ content: "Please provide an item name." });
                }

                const response = await fetch(`https://fortnite-api.com/v2/cosmetics/br/search?name=${encodeURIComponent(itemname)}`);
                const json = await response.json();

                if (json.status !== 200 || !json.data) {
                    return interaction.editReply({ content: `Could not find the item "${itemname}".` });
                }

                const itemData = json.data;
                const itemEntries = Object.entries(athena.items);
                const cosmeticId = itemData.id.toLowerCase();
                const foundEntry = itemEntries.find(([itemId, item]) => {
                    const templateId = item?.templateId || itemId;
                    return templateId.split(":")[1]?.toLowerCase() === cosmeticId;
                }) || itemEntries.find(([itemId, item]) => {
                    const templateId = item?.templateId || itemId;
                    return templateId.toLowerCase().includes(cosmeticId);
                });

                if (!foundEntry) {
                    return interaction.editReply({ content: `User does not own the item "${itemData.name}".` });
                }

                const [foundKey, foundItem] = foundEntry;
                if (athenaInventory.isBaseAthenaItem(foundKey, foundItem)) {
                    return interaction.editReply({ content: `"${itemData.name}" is a base item and cannot be removed.` });
                }

                delete athena.items[foundKey];
                await saveAthenaProfile(targetUser.accountId, athena);

                const embed = new MessageEmbed()
                    .setTitle("Item Removed")
                    .setDescription(`Successfully removed **${itemData.name}** from **${selectedUser.username}**'s account.`)
                    .setThumbnail(itemData.images.icon)
                    .setColor(UNIFIED_PURPLE)
                    .setFooter({ text: "CUBE", iconURL: "https://i.imgur.com/JKe2JcI.png" })
                    .setTimestamp();

                return await interaction.editReply({ embeds: [embed] });
            }
        } catch (error) {
            log.error("An error occurred:", error);
            interaction.editReply({ content: "An error occurred while processing the request." });
        }
    }
};
