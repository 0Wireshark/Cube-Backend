const BRAND_ICON = "https://i.imgur.com/JKe2JcI.png";

const UNIFIED_PURPLE = "#8B5CF6";

const COLORS = {
    success: UNIFIED_PURPLE,
    danger: UNIFIED_PURPLE,
    warning: UNIFIED_PURPLE,
    info: UNIFIED_PURPLE,
    accent: UNIFIED_PURPLE,
    neutral: UNIFIED_PURPLE
};

function styleEmbed(embed, options = {}) {
    const {
        tone = "info",
        section = "CUBE",
        authorName,
        authorIconURL = BRAND_ICON,
        footerText,
        thumbnail,
        image
    } = options;

    embed.setColor(COLORS[tone] || COLORS.info);

    if (authorName) {
        embed.setAuthor(authorName, authorIconURL);
    }

    if (thumbnail) {
        embed.setThumbnail(thumbnail);
    }

    if (image) {
        embed.setImage(image);
    }

    embed.setFooter({
        text: footerText || `CUBE • ${section}`,
        iconURL: BRAND_ICON
    });

    return embed;
}

module.exports = {
    BRAND_ICON,
    UNIFIED_PURPLE,
    styleEmbed
};
