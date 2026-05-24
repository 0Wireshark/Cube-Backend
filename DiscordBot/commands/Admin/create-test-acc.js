const { MessageEmbed } = require("discord.js");
const User = require("../../../model/user.js");
const Profile = require("../../../model/profiles.js");
const Friends = require("../../../model/friends.js");
const Arena = require("../../../model/arena.js");
const functions = require("../../../structs/functions.js");
const playerStats = require("../../../structs/userStats.js");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const fs = require("fs");
const sendUserDm = require("../../utils/sendUserDm.js");
const { styleEmbed } = require("../../utils/embedTheme.js");

module.exports = {
    execute: async (interaction) => {
        await interaction.deferReply({ ephemeral: true });

        const { options } = interaction;

        const discordId = interaction.user.id;
        const username = options.get("username").value;
        const email = `${interaction.user.username}@gmail.com`.toLowerCase();
        const password = crypto.randomBytes(6).toString("hex");

        const existingEmail = await User.findOne({ email });
        const existingUser = await User.findOne({ username_lower: username.toLowerCase() });

        if (username.length < 3) {
            return interaction.editReply({ content: "Your username must be at least 3 characters long.", ephemeral: true });
        }
        if (username.length > 20) {
            return interaction.editReply({ content: "Your username must be 20 characters or less.", ephemeral: true });
        }
        if (existingEmail) {
            return interaction.editReply({ content: "An account with your Discord username already exists!", ephemeral: true });
        }
        if (existingUser) {
            return interaction.editReply({ content: "Username already exists. Please choose a different one.", ephemeral: true });
        }

        const accountId = functions.MakeID().replace(/-/ig, "");
        const matchmakingId = functions.MakeID().replace(/-/ig, "");

        const emailFilter = /^([a-zA-Z0-9_\.\-])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$/;
        if (!emailFilter.test(email)) {
            return interaction.editReply({ content: "Invalid email address.", ephemeral: true });
        }

        const allowedCharacters = (" !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~").split("");
        for (const character of username) {
            if (!allowedCharacters.includes(character)) {
                return interaction.editReply({ content: "Your username has special characters, please remove them and try again.", ephemeral: true });
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        try {
            await User.create({
                created: new Date().toISOString(),
                discordId: discordId || null,
                accountId,
                username,
                username_lower: username.toLowerCase(),
                email,
                password: hashedPassword,
                matchmakingId
            }).then(async (i) => {
                const allAthenaProfile = JSON.parse(fs.readFileSync("./Config/DefaultProfiles/allathena.json").toString());
                allAthenaProfile.accountId = i.accountId;
                allAthenaProfile.created = i.created;
                allAthenaProfile.updated = new Date().toISOString();

                const profiles = {};
                fs.readdirSync("./Config/DefaultProfiles").forEach((fileName) => {
                    if (fileName === "allathena.json") return;

                    const profile = JSON.parse(fs.readFileSync(`./Config/DefaultProfiles/${fileName}`).toString());
                    profile.accountId = i.accountId;
                    profile.created = i.created;
                    profile.updated = new Date().toISOString();

                    if (fileName === "athena.json") {
                        profiles[profile.profileId] = allAthenaProfile;
                    } else {
                        profiles[profile.profileId] = profile;
                    }
                });

                await Profile.create({ created: i.created, accountId: i.accountId, profiles });
                await Friends.create({ created: i.created, accountId: i.accountId });
                await Arena.create({ accountId: i.accountId, hype: 0, division: 0 });
                await playerStats.ensureUserStats(i.accountId);
            });

            const embed = styleEmbed(
                new MessageEmbed()
                    .setTitle("Test Account Ready")
                    .setDescription("Your test account has been created with **all cosmetics** enabled.")
                    .addFields({
                        name: "Username",
                        value: username,
                        inline: true
                    }, {
                        name: "Email",
                        value: email,
                        inline: true
                    }, {
                        name: "Password",
                        value: `||${password}||`,
                        inline: true
                    })
                    .setTimestamp(),
                {
                    tone: "success",
                    section: "Test Account",
                    authorName: interaction.user.username,
                    authorIconURL: interaction.user.displayAvatarURL({ dynamic: true })
                }
            );

            const dmSent = await sendUserDm(interaction.user, {
                content: `Hello ${interaction.user.username}, here are your test account details for CUBE:`,
                embeds: [embed]
            });

            return interaction.editReply({
                content: dmSent
                    ? "Test account created successfully with all cosmetics! I have also sent your details to your DMs."
                    : "Test account created successfully with all cosmetics, but I couldn't DM you. Please make sure your DMs are open.",
                ephemeral: true
            });
        } catch (err) {
            console.error(err);
            if (err.code == 11000) {
                return interaction.editReply({ content: "Username or email is already in use.", ephemeral: true });
            }
            return interaction.editReply({ content: "An unknown error has occurred, please try again later.", ephemeral: true });
        }
    },
    executePrefix: async (message, args) => {
        await message.delete().catch(() => {});

        const username = args[0];
        const respond = async (content) => {
            const dmSent = await sendUserDm(message.author, { content }).catch(() => false);
            if (dmSent) return;

            const reply = await message.channel.send(content).catch(() => null);
            if (reply) {
                setTimeout(() => reply.delete().catch(() => {}), 10000);
            }
        };

        if (!username) {
            return respond("Usage: `+testacc username`");
        }

        const discordId = message.author.id;
        const email = `${message.author.username}@gmail.com`.toLowerCase();
        const password = crypto.randomBytes(6).toString("hex");

        const existingEmail = await User.findOne({ email });
        const existingUser = await User.findOne({ username_lower: username.toLowerCase() });

        if (username.length < 3) {
            return respond("Your username must be at least 3 characters long.");
        }
        if (username.length > 20) {
            return respond("Your username must be 20 characters or less.");
        }
        if (existingEmail) {
            return respond("An account with your Discord username already exists!");
        }
        if (existingUser) {
            return respond("Username already exists. Please choose a different one.");
        }

        const accountId = functions.MakeID().replace(/-/ig, "");
        const matchmakingId = functions.MakeID().replace(/-/ig, "");
        const emailFilter = /^([a-zA-Z0-9_\.\-])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$/;

        if (!emailFilter.test(email)) {
            return respond("Invalid email address.");
        }

        const allowedCharacters = (" !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~").split("");
        for (const character of username) {
            if (!allowedCharacters.includes(character)) {
                return respond("Your username has special characters, please remove them and try again.");
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        try {
            await User.create({
                created: new Date().toISOString(),
                discordId: discordId || null,
                accountId,
                username,
                username_lower: username.toLowerCase(),
                email,
                password: hashedPassword,
                matchmakingId
            }).then(async (i) => {
                const allAthenaProfile = JSON.parse(fs.readFileSync("./Config/DefaultProfiles/allathena.json").toString());
                allAthenaProfile.accountId = i.accountId;
                allAthenaProfile.created = i.created;
                allAthenaProfile.updated = new Date().toISOString();

                const profiles = {};
                fs.readdirSync("./Config/DefaultProfiles").forEach((fileName) => {
                    if (fileName === "allathena.json") return;

                    const profile = JSON.parse(fs.readFileSync(`./Config/DefaultProfiles/${fileName}`).toString());
                    profile.accountId = i.accountId;
                    profile.created = i.created;
                    profile.updated = new Date().toISOString();

                    if (fileName === "athena.json") {
                        profiles[profile.profileId] = allAthenaProfile;
                    } else {
                        profiles[profile.profileId] = profile;
                    }
                });

                await Profile.create({ created: i.created, accountId: i.accountId, profiles });
                await Friends.create({ created: i.created, accountId: i.accountId });
                await Arena.create({ accountId: i.accountId, hype: 0, division: 0 });
                await playerStats.ensureUserStats(i.accountId);
            });

            const embed = styleEmbed(
                new MessageEmbed()
                    .setTitle("Test Account Ready")
                    .setDescription("Your test account has been created with **all cosmetics** enabled.")
                    .addFields({
                        name: "Username",
                        value: username,
                        inline: true
                    }, {
                        name: "Email",
                        value: email,
                        inline: true
                    }, {
                        name: "Password",
                        value: `||${password}||`,
                        inline: true
                    })
                    .setTimestamp(),
                {
                    tone: "success",
                    section: "Test Account",
                    authorName: message.author.username,
                    authorIconURL: message.author.displayAvatarURL({ dynamic: true })
                }
            );

            const dmSent = await sendUserDm(message.author, {
                content: `Hello ${message.author.username}, here are your test account details for CUBE:`,
                embeds: [embed]
            });

            if (!dmSent) {
                return respond("Test account created, but I couldn't DM you. Please open your DMs.");
            }
        } catch (err) {
            console.error(err);
            if (err.code == 11000) {
                return respond("Username or email is already in use.");
            }
            return respond("An unknown error has occurred, please try again later.");
        }
    }
};
