const { MessageEmbed } = require("discord.js");
const functions = require("../../../structs/functions.js");
const User = require("../../../model/user.js");
const log = require("../../../structs/log.js");
const sendUserDm = require("../../utils/sendUserDm.js");
const { styleEmbed } = require("../../utils/embedTheme.js");

module.exports = {
    commandInfo: {
        name: "hostacc",
        description: "Creates a host account for CUBE."
    },
    execute: async (interaction) => {
        await interaction.deferReply({ ephemeral: true });

        const serverOwnerId = interaction.guild.ownerId;

        if (interaction.user.id !== serverOwnerId) {
            return interaction.editReply({
                content: "Only the server owner can execute this command.",
                ephemeral: true
            });
        }

        const existingHostAccount = await User.findOne({ $or: [{ email: /^hostaccount@/i }, { username_lower: /hostaccount$|_host$/i }] });

        if (existingHostAccount) {
            return interaction.editReply({
                content: "A host account has already been created.",
                ephemeral: true
            });
        }

        const username = "cubehostaccount";
        const email = "hostaccount@cubebackend.com";
        const password = generateRandomPassword(12);

        try {
            await functions.registerUser(null, username, email, password).then(async (resp) => {
                const embed = styleEmbed(
                    new MessageEmbed()
                        .setTitle(resp.status >= 400 ? "Host Account Error" : "Host Account Created")
                        .setDescription(resp.status >= 400 ? "CUBE could not create the host account." : "The host account is ready. Store these credentials securely.")
                        .addFields(
                            { name: "Message", value: resp.message },
                            { name: "Username", value: `\`\`\`${username}\`\`\`` },
                            { name: "Email", value: `\`\`\`${email}\`\`\`` },
                            { name: "Password", value: `\`\`\`${password}\`\`\`` }
                        )
                        .setTimestamp(),
                    {
                        tone: resp.status >= 400 ? "danger" : "success",
                        section: "Host Account",
                        authorName: interaction.user.username,
                        authorIconURL: interaction.user.displayAvatarURL({ dynamic: true })
                    }
                );

                if (resp.status >= 400) {
                    return interaction.editReply({ embeds: [embed], ephemeral: true });
                }

                const dmSent = await sendUserDm(interaction.user, {
                    content: "Here are the host account details for CUBE:",
                    embeds: [embed]
                });

                return interaction.editReply({
                    content: dmSent
                        ? "Host account created successfully. I sent the credentials to your DMs."
                        : "Host account created successfully, but I couldn't DM you. Please make sure your DMs are open.",
                    ephemeral: true
                });
            });
        } catch (error) {
            log.error(error);
            return interaction.editReply({
                content: "An error occurred while creating the host account.",
                ephemeral: true
            });
        }
    },
    executePrefix: async (message) => {
        await message.delete().catch(() => {});

        const respond = async (content) => {
            const dmSent = await sendUserDm(message.author, { content }).catch(() => false);
            if (dmSent) return;

            const reply = await message.channel.send(content).catch(() => null);
            if (reply) {
                setTimeout(() => reply.delete().catch(() => {}), 10000);
            }
        };

        const serverOwnerId = message.guild?.ownerId;

        if (!serverOwnerId || message.author.id !== serverOwnerId) {
            return respond("Only the server owner can execute this command.");
        }

        const existingHostAccount = await User.findOne({ $or: [{ email: /^hostaccount@/i }, { username_lower: /hostaccount$|_host$/i }] });

        if (existingHostAccount) {
            return respond("A host account has already been created.");
        }

        const username = "cubehostaccount";
        const email = "hostaccount@cubebackend.com";
        const password = generateRandomPassword(12);

        try {
            const resp = await functions.registerUser(null, username, email, password);

            const embed = styleEmbed(
                new MessageEmbed()
                    .setTitle(resp.status >= 400 ? "Host Account Error" : "Host Account Created")
                    .setDescription(resp.status >= 400 ? "CUBE could not create the host account." : "The host account is ready. Store these credentials securely.")
                    .addFields(
                        { name: "Message", value: resp.message },
                        { name: "Username", value: `\`\`\`${username}\`\`\`` },
                        { name: "Email", value: `\`\`\`${email}\`\`\`` },
                        { name: "Password", value: `\`\`\`${password}\`\`\`` }
                    )
                    .setTimestamp(),
                {
                    tone: resp.status >= 400 ? "danger" : "success",
                    section: "Host Account",
                    authorName: message.author.username,
                    authorIconURL: message.author.displayAvatarURL({ dynamic: true })
                }
            );

            if (resp.status >= 400) {
                const dmSent = await sendUserDm(message.author, {
                    content: "CUBE could not create the host account.",
                    embeds: [embed]
                });

                if (!dmSent) {
                    const reply = await message.channel.send({ embeds: [embed] }).catch(() => null);
                    if (reply) {
                        setTimeout(() => reply.delete().catch(() => {}), 10000);
                    }
                }
                return;
            }

            const dmSent = await sendUserDm(message.author, {
                content: "Here are the host account details for CUBE:",
                embeds: [embed]
            });

            if (!dmSent) {
                return respond("Host account created successfully, but I couldn't DM you. Please make sure your DMs are open.");
            }
        } catch (error) {
            log.error(error);
            return respond("An error occurred while creating the host account.");
        }
    }
};

function generateRandomPassword(length) {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+<>?";
    let password = "";
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * charset.length);
        password += charset[randomIndex];
    }
    return password;
}
