const { Client, Intents, MessageEmbed } = require("discord.js");
const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.GUILD_MEMBERS, Intents.FLAGS.GUILD_BANS, Intents.FLAGS.DIRECT_MESSAGES] });
global.discordClient = client;
global.botConnected = false;
const DISCORD_EMBED_COLOR = "#8A2BE2";
const fs = require("fs");
const path = require("path");
const config = require("../structs/config.js");
const log = require("../structs/log.js");
const Users = require("../model/user.js");
const functions = require("../structs/functions.js");

// Cache commands to avoid repeated require() calls
const commandCache = new Map();

const originalSetColor = MessageEmbed.prototype.setColor;
MessageEmbed.prototype.setColor = function () {
    return originalSetColor.call(this, DISCORD_EMBED_COLOR);
};

const makeEphemeralPayload = (payload) => {
    if (typeof payload === "string") {
        return { content: payload, ephemeral: true };
    }

    if (!payload || typeof payload !== "object") {
        return { ephemeral: true };
    }

    return { ...payload, ephemeral: true };
};

const forcePrivateCommandReplies = (interaction) => {
    if (interaction._cubePrivateRepliesPatched) return;

    const originalReply = interaction.reply.bind(interaction);
    const originalDeferReply = interaction.deferReply.bind(interaction);
    const originalFollowUp = interaction.followUp.bind(interaction);

    interaction.reply = (payload) => originalReply(makeEphemeralPayload(payload));
    interaction.deferReply = (payload = {}) => originalDeferReply(makeEphemeralPayload(payload));
    interaction.followUp = (payload) => originalFollowUp(makeEphemeralPayload(payload));
    interaction._cubePrivateRepliesPatched = true;
};

client.once("ready", () => {
    global.botConnected = true;
    log.bot("Bot is up and running!");

    if (config.bEnableBackendStatus) {
        if (!config.bBackendStatusChannelId || config.bBackendStatusChannelId.trim() === "") {
            log.error("The channel ID has not been set in config.json for bEnableBackendStatus.");
        } else {
            const channel = client.channels.cache.get(config.bBackendStatusChannelId);
            if (!channel) {
                log.error(`Cannot find the channel with ID ${config.bBackendStatusChannelId}`);
            } else {
                const embed = new MessageEmbed()
                    .setTitle("Backend Online")
                    .setDescription("CUBE is now online")
                    .setColor(DISCORD_EMBED_COLOR)
                    .setThumbnail("https://i.imgur.com/jhUfbwy.png")
                    .setFooter({
                        text: "CUBE",
                        iconURL: "https://i.imgur.com/jhUfbwy.png",
                    })
                    .setTimestamp();

                channel.send({ embeds: [embed] }).catch(err => {
                    log.error(err);
                });
            }
        }
    }

    let commandData = [];
    const loadCommands = (dir) => {
        fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            if (fs.lstatSync(filePath).isDirectory()) {
                loadCommands(filePath);
            } else if (file.endsWith(".js")) {
                try {
                    delete require.cache[require.resolve(filePath)]; 
                    const command = require(filePath);
                    if (command.commandInfo) {
                        commandData.push(command.commandInfo);
                    }
                } catch (err) {
                    log.error(`Failed to load command at ${filePath}: ${err}`);
                }
            }
        });
    };

    loadCommands(path.join(__dirname, "commands"));
    client.application.commands.set(commandData).then(() => {
        log.bot("Successfully synchronized application commands.");
    }).catch(err => {
        log.error(`Failed to sync application commands: ${err}`);
    });
});

client.on("interactionCreate", async interaction => {
    const executeCommand = (dir, commandName) => {
        const commandPath = path.join(dir, commandName + ".js");
        if (fs.existsSync(commandPath)) {
            // Use cached command if available
            let command = commandCache.get(commandPath);
            if (!command) {
                command = require(commandPath);
                commandCache.set(commandPath, command);
            }
            
            if (interaction.isApplicationCommand()) {
                forcePrivateCommandReplies(interaction);
                command.execute(interaction);
            } else if (interaction.isAutocomplete() && command.autocomplete) {
                command.autocomplete(interaction);
            }
            return true;
        }
        const subdirectories = fs.readdirSync(dir).filter(subdir => fs.lstatSync(path.join(dir, subdir)).isDirectory());
        for (const subdir of subdirectories) {
            if (executeCommand(path.join(dir, subdir), commandName)) {
                return true;
            }
        }
        return false;
    };

    if (interaction.isApplicationCommand() || interaction.isAutocomplete()) {
        executeCommand(path.join(__dirname, "commands"), interaction.commandName);
    }
});

client.on("messageCreate", async message => {
    if (message.author.bot || !message.content.startsWith("+testacc")) return;

    const args = message.content.trim().split(/\s+/).slice(1);
    const commandPath = path.join(__dirname, "commands", "Admin", "create-test-acc.js");
    
    let command = commandCache.get(commandPath);
    if (!command) {
        command = require(commandPath);
        commandCache.set(commandPath, command);
    }

    if (command.executePrefix) {
        await command.executePrefix(message, args);
    }
});

client.on("messageCreate", async message => {
    if (message.author.bot || !message.content.startsWith("+hostacc")) return;

    const commandPath = path.join(__dirname, "commands", "Admin", "hostacc.js");
    
    let command = commandCache.get(commandPath);
    if (!command) {
        command = require(commandPath);
        commandCache.set(commandPath, command);
    }

    if (command.executePrefix) {
        await command.executePrefix(message);
    }
});

client.on("messageCreate", async message => {
    const parts = message.content.trim().split(/\s+/);
    if (message.author.bot || parts[0]?.toLowerCase() !== "+updatelauncher") return;

    const args = parts.slice(1);
    const commandPath = path.join(__dirname, "commands", "Admin", "updatelauncher.js");

    let command = commandCache.get(commandPath);
    if (!command) {
        command = require(commandPath);
        commandCache.set(commandPath, command);
    }

    if (command.executePrefix) {
        await command.executePrefix(message, args);
    }
});

client.on("messageCreate", async message => {
    const commandName = message.content.trim().split(/\s+/)[0]?.toLowerCase();
    if (message.author.bot || (commandName !== "+maintenance" && commandName !== "-maintenance")) return;

    const commandPath = path.join(__dirname, "commands", "Admin", "maintenance.js");

    let command = commandCache.get(commandPath);
    if (!command) {
        command = require(commandPath);
        commandCache.set(commandPath, command);
    }

    if (command.executePrefix) {
        await command.executePrefix(message, commandName === "+maintenance");
    }
});

client.on("guildBanAdd", async (ban) => {
    if (!config.bEnableCrossBans) 
        return;

    const memberBan = await ban.fetch();

    if (memberBan.user.bot)
        return;

    const userData = await Users.findOne({ discordId: memberBan.user.id });

    if (userData && userData.banned !== true) {
        await userData.updateOne({ $set: { banned: true } });

        let refreshToken = global.refreshTokens.findIndex(i => i.accountId == userData.accountId);

        if (refreshToken != -1)
            global.refreshTokens.splice(refreshToken, 1);
        let accessToken = global.accessTokens.findIndex(i => i.accountId == userData.accountId);

        if (accessToken != -1) {
            global.accessTokens.splice(accessToken, 1);
            let xmppClient = global.Clients.find(client => client.accountId == userData.accountId);
            if (xmppClient)
                xmppClient.client.close();
        }

        if (accessToken != -1 || refreshToken != -1) {
            await functions.UpdateTokens();
        }

        log.debug(`user ${memberBan.user.username} (ID: ${memberBan.user.id}) was banned on the discord and also in the game (Cross Ban active).`);
    }
});

client.on("guildBanRemove", async (ban) => {
    if (!config.bEnableCrossBans) 
        return;

    if (ban.user.bot)
        return;

    const userData = await Users.findOne({ discordId: ban.user.id });
    
    if (userData && userData.banned === true) {
        await userData.updateOne({ $set: { banned: false } });

        log.debug(`User ${ban.user.username} (ID: ${ban.user.id}) is now unbanned.`);
    }
});


client.on("error", (err) => {
    log.error("Discord API Error:", err);
});
  
process.on("unhandledRejection", (reason, p) => {
    log.error("Unhandled promise rejection:", reason, p);
});
  
process.on("uncaughtException", (err, origin) => {
    log.error("Uncaught Exception:", err, origin);
});
  
process.on("uncaughtExceptionMonitor", (err, origin) => {
    log.error("Uncaught Exception Monitor:", err, origin);
});

if (!config.discord.bot_token || config.discord.bot_token.trim() === "") {
    log.error("Discord bot token is not set in config.json! Please add your bot token to enable the Discord bot.");
    global.botConnected = false;
} else {
    client.login(config.discord.bot_token).catch(err => {
        log.error("Failed to login to Discord bot. Please check your bot token in config.json");
        log.error(`Discord login error: ${err.message}`);
        global.botConnected = false;
    });
}
