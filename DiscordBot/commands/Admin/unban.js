const { MessageEmbed } = require("discord.js");
const User = require("../../../model/user.js");
const config = require("../../../structs/config.js");
const { styleEmbed } = require("../../utils/embedTheme.js");
const { unbanAccount } = require("../../../anticheat/database/bans");

module.exports = {
    commandInfo: {
        name: "unban",
        description: "Unban a user from the backend by their username.",
        options: [
            {
                name: "username",
                description: "Target username.",
                required: true,
                type: 3
            }
        ]
    },
    execute: async (interaction) => {
        await interaction.deferReply({ ephemeral: true });

        if (!config.moderators.includes(interaction.user.id)) {
            return interaction.editReply({ content: "You do not have moderator permissions.", ephemeral: true });
        }

        const { options } = interaction;
        const targetUser = await User.findOne({ username_lower: options.get("username").value.toLowerCase() });

        if (!targetUser) return interaction.editReply({ content: "The account username you entered does not exist.", ephemeral: true });
        if (!targetUser.banned) return interaction.editReply({ content: "This account is already unbanned.", ephemeral: true });

        await targetUser.updateOne({ $set: { banned: false, banExpires: null, banReason: null } });

        // === UNBAN DANS L'ANTI-CHEAT ===
        try {
            await unbanAccount(targetUser.accountId, `Unbanned by moderator ${interaction.user.tag}`);
        } catch (error) {
            console.error(`Failed to unban in anti-cheat system: ${error.message}`);
        }

        let dmStatus = "";
        if (targetUser.discordId) {
            try {
                const discordUser = await interaction.client.users.fetch(targetUser.discordId);
                const unbanEmbed = styleEmbed(
                    new MessageEmbed()
                        .setTitle("Restriction Removed")
                        .setDescription(`Your account **${targetUser.username}** has been unbanned from **CUBE**.`)
                        .addField("Status", "You can now log back into the game.", false)
                        .setTimestamp(),
                    {
                        tone: "success",
                        section: "Admin Team",
                        authorName: "Account Status"
                    }
                );

                await discordUser.send({ embeds: [unbanEmbed] });
                dmStatus = " (User notified via DM)";
            } catch (err) {
                dmStatus = " (Could not DM user - DMs closed or user not found)";
            }
        } else {
            dmStatus = " (User has no linked Discord ID)";
        }

        interaction.editReply({ content: `Successfully unbanned **${targetUser.username}**.${dmStatus}`, ephemeral: true });
    }
};
