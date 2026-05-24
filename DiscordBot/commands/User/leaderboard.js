// const { MessageEmbed } = require("discord.js");
// const Arena = require("../../../model/arena.js");
// const User = require("../../../model/user.js");
// const { styleEmbed } = require("../../utils/embedTheme.js");

// let cachedDescription = null;
// let lastUpdate = 0;
// const CACHE_DURATION = 60 * 60 * 1000;

// function createLeaderboardEmbed(description, options = {}) {
//     const {
//         isRandom = false,
//         playerCount = 0,
//         nextUpdateMinutes,
//         timestamp = new Date()
//     } = options;

//     const statusText = nextUpdateMinutes
//         ? `Refresh in ${nextUpdateMinutes}m`
//         : "Refresh every 1 hour";

//     return styleEmbed(
//         new MessageEmbed()
//             .setTitle(isRandom ? "CUBE Arena Leaderboard Preview" : "CUBE Arena Leaderboard")
//             .setDescription(description)
//             .addFields(
//                 {
//                     name: "Mode",
//                     value: "Arena Hype",
//                     inline: true
//                 },
//                 {
//                     name: "Players",
//                     value: `${playerCount}/10`,
//                     inline: true
//                 },
//                 {
//                     name: "Status",
//                     value: statusText,
//                     inline: true
//                 }
//             )
//             .setTimestamp(timestamp),
//         {
//             tone: isRandom ? "info" : "accent",
//             section: isRandom ? "Preview Results" : statusText,
//             authorName: isRandom ? "Random Player Sample" : "Top Arena Players"
//         }
//     );
// }

// module.exports = {
//     commandInfo: {
//         name: "leaderboard",
//         description: "Shows the top 10 players with the most Arena Hype points (Updates every 1H).",
//     },
//     execute: async (interaction) => {
//         await interaction.deferReply();

//         const currentTime = Date.now();
//         const timeUntilUpdate = lastUpdate + CACHE_DURATION - currentTime;

//         if (cachedDescription && currentTime - lastUpdate < CACHE_DURATION) {
//             const nextUpdateMinutes = Math.ceil(timeUntilUpdate / (60 * 1000));
//             const embed = createLeaderboardEmbed(cachedDescription, {
//                 playerCount: cachedDescription === "No players ranked yet." ? 0 : cachedDescription.split("\n\n").filter(Boolean).length,
//                 nextUpdateMinutes,
//                 timestamp: new Date(lastUpdate)
//             });

//             return interaction.editReply({ embeds: [embed] });
//         }

//         try {
//             let topArenaPlayers = await Arena.find({}).sort({ hype: -1 }).limit(10);
//             let isRandom = false;

//             if (!topArenaPlayers || topArenaPlayers.length === 0) {
//                 const randomUsers = await User.aggregate([{ $sample: { size: 10 } }]);

//                 if (!randomUsers || randomUsers.length === 0) {
//                     const noDataEmbed = styleEmbed(
//                         new MessageEmbed()
//                             .setTitle("CUBE Arena Leaderboard")
//                             .setDescription("No players were found in the database yet.")
//                             .addFields(
//                                 {
//                                     name: "Mode",
//                                     value: "Arena Hype",
//                                     inline: true
//                                 },
//                                 {
//                                     name: "Players",
//                                     value: "0/10",
//                                     inline: true
//                                 },
//                                 {
//                                     name: "Status",
//                                     value: "Waiting for data",
//                                     inline: true
//                                 }
//                             )
//                             .setTimestamp(),
//                         {
//                             tone: "info",
//                             section: "No Data",
//                             authorName: "Leaderboard"
//                         }
//                     );
//                     return interaction.editReply({ embeds: [noDataEmbed] });
//                 }

//                 topArenaPlayers = randomUsers.map((u) => ({
//                     accountId: u.accountId,
//                     hype: 0,
//                     division: 1
//                 }));
//                 isRandom = true;
//             }

//             let description = "";
//             for (let i = 0; i < topArenaPlayers.length; i++) {
//                 const entry = topArenaPlayers[i];
//                 const user = await User.findOne({ accountId: entry.accountId });
//                 const username = user ? user.username : "Unknown User";
//                 const rankLabel = `#${String(i + 1).padStart(2, "0")}`;
//                 const hype = Number(entry.hype || 0).toLocaleString("en-US");
//                 const division = entry.division || 1;

//                 description += `\`${rankLabel}\` **${username}**\n`;
//                 description += `Hype: \`${hype}\` | Division: \`${division}\`\n\n`;
//             }

//             cachedDescription = description || "No players ranked yet.";
//             lastUpdate = currentTime;

//             const embed = createLeaderboardEmbed(cachedDescription, {
//                 isRandom,
//                 playerCount: topArenaPlayers.length
//             });

//             await interaction.editReply({ embeds: [embed] });
//         } catch (error) {
//             console.error("Leaderboard Command Error:", error);
//             await interaction.editReply("An error occurred while fetching the leaderboard.");
//         }
//     },
// };
