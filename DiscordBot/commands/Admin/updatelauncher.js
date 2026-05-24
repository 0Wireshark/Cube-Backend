const { MessageEmbed } = require("discord.js");
const config = require("../../../structs/config.js");
const launcherSettings = require("../../../structs/launcherSettings.js");
const { styleEmbed } = require("../../utils/embedTheme.js");

const VERSION_PATTERN = /^\d+(?:\.\d+){0,3}$/;

function hasPermission(userId, guildOwnerId) {
    return userId === guildOwnerId || (Array.isArray(config.moderators) && config.moderators.includes(userId));
}

function normalizeVersion(value) {
    const version = String(value || "").trim();
    return VERSION_PATTERN.test(version) ? version : "";
}

function saveLauncherVersion(version) {
    return launcherSettings.setLauncherVersion(version);
}

function buildSuccessEmbed(version, author) {
    return styleEmbed(
        new MessageEmbed()
            .setTitle("Launcher Update Enabled")
            .setDescription("Launchers older than this version will now see the update screen.")
            .addFields(
                { name: "Minimum", value: version, inline: true },
                { name: "Latest", value: version, inline: true }
            )
            .setTimestamp(),
        {
            tone: "success",
            section: "Launcher",
            authorName: author?.username || "CUBE",
            authorIconURL: author?.displayAvatarURL?.({ dynamic: true })
        }
    );
}

module.exports = {
    commandInfo: {
        name: "updatelauncher",
        description: "Updates the required CUBE launcher version.",
        options: [
            {
                name: "version",
                description: "New required launcher version, for example 1.1.",
                required: true,
                type: 3
            }
        ]
    },
    execute: async (interaction) => {
        await interaction.deferReply({ ephemeral: true });

        if (!hasPermission(interaction.user.id, interaction.guild?.ownerId)) {
            return interaction.editReply({ content: "You do not have moderator permissions.", ephemeral: true });
        }

        const version = normalizeVersion(interaction.options.getString("version"));
        if (!version) {
            return interaction.editReply({ content: "Usage: `/updatelauncher version:1.1`", ephemeral: true });
        }

        try {
            saveLauncherVersion(version);
            return interaction.editReply({ embeds: [buildSuccessEmbed(version, interaction.user)], ephemeral: true });
        } catch (err) {
            console.error(err);
            return interaction.editReply({ content: "Unable to update launcher version.", ephemeral: true });
        }
    },
    executePrefix: async (message, args) => {
        await message.delete().catch(() => {});

        const respond = async (payload) => {
            const reply = await message.channel.send(payload).catch(() => null);
            if (reply) {
                setTimeout(() => reply.delete().catch(() => {}), 10000);
            }
        };

        if (!hasPermission(message.author.id, message.guild?.ownerId)) {
            return respond("You do not have moderator permissions.");
        }

        const versionArg = args[0]?.toLowerCase() === "to" ? args[1] : args[0];
        const version = normalizeVersion(versionArg);
        if (!version) {
            return respond("Usage: `+updatelauncher 1.1` or `+updatelauncher to 1.1`");
        }

        try {
            saveLauncherVersion(version);
            return respond({ embeds: [buildSuccessEmbed(version, message.author)] });
        } catch (err) {
            console.error(err);
            return respond("Unable to update launcher version.");
        }
    }
};
