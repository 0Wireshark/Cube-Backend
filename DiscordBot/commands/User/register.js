/*
const { MessageEmbed } = require("discord.js");
const User = require("../../../model/user.js");
const functions = require("../../../structs/functions.js");
const crypto = require("crypto");
const sendUserDm = require("../../utils/sendUserDm.js");
const { styleEmbed } = require("../../utils/embedTheme.js");

module.exports = {
    commandInfo: {
        name: "register",
        description: "Creates an account on CUBE.",
        options: [
            {
                name: "username",
                description: "Your username.",
                required: true,
                type: 3
            }
        ],
    },
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

        const resp = await functions.registerUser(discordId, username, email, password);
        const isError = resp.status >= 400;

        const embed = styleEmbed(
            new MessageEmbed()
                .setTitle(isError ? "Account Creation Failed" : "Account Ready")
                .setDescription(
                    isError
                        ? "CUBE could not finish creating your account."
                        : "Your account has been created successfully. Keep these details safe."
                )
                .addFields(
                    {
                        name: "Username",
                        value: username,
                        inline: true
                    },
                    {
                        name: "Email",
                        value: email,
                        inline: true
                    },
                    {
                        name: "Password",
                        value: isError ? "N/A" : `||${password}||`,
                        inline: true
                    },
                    {
                        name: "Details",
                        value: resp.message || "Unknown error",
                        inline: false
                    }
                )
                .setTimestamp(),
            {
                tone: isError ? "danger" : "success",
                section: "Account",
                authorName: interaction.user.username,
                authorIconURL: interaction.user.displayAvatarURL({ dynamic: true })
            }
        );

        const dmSent = await sendUserDm(interaction.user, {
            content: isError
                ? `Hello ${interaction.user.username}, here is the result of your CUBE account creation attempt:`
                : `Hello ${interaction.user.username}, here are your account details for CUBE:`,
            embeds: [embed]
        });

        if (isError) {
            return interaction.editReply({
                content: dmSent
                    ? `Account creation failed: ${resp.message}. I also sent the details to your DMs.`
                    : `Account creation failed: ${resp.message}. I couldn't DM you, so I'm showing it here instead.`,
                embeds: dmSent ? [] : [embed],
                ephemeral: true
            });
        }

        return interaction.editReply({
            content: dmSent
                ? "Account created successfully! I have also sent your details to your DMs."
                : "Account created successfully, but I couldn't DM you. Please make sure your DMs are open.",
            ephemeral: true
        });
    }
};
*/

module.exports = {
    execute: async (interaction) => {
        return interaction.reply({
            content: "La commande /register est desactivee.",
            ephemeral: true
        });
    }
};
