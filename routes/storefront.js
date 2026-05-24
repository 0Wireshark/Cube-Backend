const express = require("express");
const app = express.Router();
const Profile = require("../model/profiles.js");
const Friends = require("../model/friends.js");
const functions = require("../structs/functions.js");
const gifting = require("../structs/gifting.js");
const log = require("../structs/log.js");
const error = require("../structs/error.js");

const { verifyToken, verifyClient } = require("../tokenManager/tokenVerify.js");
const keychain = require("../responses/keychain.json");

function normalizeTemplateId(value) {
    return String(value || "").trim().toLowerCase();
}

function buildOwnedTemplateSet(items) {
    return new Set(
        Object.values(items || {})
            .map((item) => normalizeTemplateId(item?.templateId))
            .filter(Boolean)
    );
}

app.get("/fortnite/api/storefront/v2/catalog", (req, res) => {
    log.debug("Request to /fortnite/api/storefront/v2/catalog");
    if (req.headers["user-agent"] == undefined) return;
    if (req.headers["user-agent"].includes("2870186")) {
        return res.status(404).end();
    }
    
    const shopJson = functions.getItemShopResponse();
    if (!shopJson) {
        log.error("getItemShop returned undefined/null");
        return res.status(500).json({ error: "Failed to load catalog" });
    }
    res.type("application/json").send(shopJson);
});

app.get("/fortnite/api/storefront/v2/gift/check_eligibility/recipient/:recipientId/offer/:offerId", verifyToken, async (req, res) => {
    log.debug(`Request to /fortnite/api/storefront/v2/gift/check_eligibility/recipient/${req.params.recipientId}/offer/${req.params.offerId}`);
    const findOfferId = functions.getOfferID(req.params.offerId);
    if (!findOfferId) return error.createError(
        "errors.com.epicgames.fortnite.id_invalid",
        `Offer ID (id: "${req.params.offerId}") not found`,
        [req.params.offerId], 16027, undefined, 400, res
    );
    if (
        !Array.isArray(findOfferId.offerId?.itemGrants) ||
        !findOfferId.offerId?.prices?.[0] ||
        findOfferId.offerId.itemGrants.some((itemGrant) => typeof itemGrant?.templateId != "string")
    ) return error.createError(
        "errors.com.epicgames.fortnite.id_invalid",
        `Offer ID (id: "${req.params.offerId}") is not giftable`,
        [req.params.offerId], 16027, undefined, 400, res
    );

    const [sender, senderProfiles, profiles] = await Promise.all([
        Friends.findOne({ accountId: req.user.accountId }).lean(),
        Profile.findOne({ accountId: req.user.accountId }).lean(),
        Profile.findOne({ accountId: req.params.recipientId }).lean()
    ]);

    if (!sender) return error.createError(
        "errors.com.epicgames.friends.no_relationship",
        `User ${req.user.accountId} has no friends list`,
        [req.user.accountId], 28004, undefined, 403, res
    );

    const senderCommonCore = senderProfiles?.profiles?.common_core;
    if (!senderProfiles || !senderCommonCore) return error.createError(
        "errors.com.epicgames.account.account_not_found",
        `User ${req.user.accountId} not found`,
        [req.user.accountId], 18007, undefined, 404, res
    );

    if (!gifting.canSendGifts(senderCommonCore)) return error.createError(
        "errors.com.epicgames.user.gift_disabled",
        `User ${req.user.accountId} has disabled sending gifts.`,
        [req.user.accountId], 28004, undefined, 403, res
    );

    const relationship = gifting.validateGiftRelationship(sender, req.user.accountId, req.params.recipientId);
    if (relationship.reason == "friendship_too_new") return error.createError(
        "errors.com.epicgames.friends.friendship_too_new",
        `User ${req.user.accountId} can not gift ${req.params.recipientId} yet.`,
        [req.user.accountId, req.params.recipientId, relationship.waitSeconds], 28004, undefined, 403, res
    );

    if (!relationship.ok) return error.createError(
        "errors.com.epicgames.friends.no_relationship",
        `User ${req.user.accountId} is not friends with ${req.params.recipientId}`,
        [req.user.accountId, req.params.recipientId], 28004, undefined, 403, res
    );

    if (!profiles) return error.createError(
        "errors.com.epicgames.account.account_not_found",
        `User ${req.params.recipientId} not found`,
        [req.params.recipientId], 18007, undefined, 404, res
    );

    let athena = profiles.profiles?.athena;
    let commonCore = profiles.profiles?.common_core;

    if (!athena || !commonCore) return error.createError(
        "errors.com.epicgames.account.account_not_found",
        `User ${req.params.recipientId} profile not found`,
        [req.params.recipientId], 18007, undefined, 404, res
    );

    if (!gifting.canReceiveGifts(commonCore)) return error.createError(
        "errors.com.epicgames.user.gift_disabled",
        `User ${req.params.recipientId} has disabled receiving gifts.`,
        [req.params.recipientId], 28004, undefined, 403, res
    );

    if (!athena.items) athena.items = {};
    const ownedAthenaTemplates = buildOwnedTemplateSet(athena.items);

    for (let itemGrant of findOfferId.offerId.itemGrants) {
        if (ownedAthenaTemplates.has(normalizeTemplateId(itemGrant.templateId))) return error.createError(
            "errors.com.epicgames.modules.gamesubcatalog.purchase_not_allowed",
            `Could not purchase catalog offer ${findOfferId.offerId.devName}, item ${itemGrant.templateId}`,
            [findOfferId.offerId.devName, itemGrant.templateId], 28004, undefined, 403, res
        );
    }

    res.json({
        price: findOfferId.offerId.prices[0],
        items: findOfferId.offerId.itemGrants
    });
});

app.get("/fortnite/api/storefront/v2/keychain", (req, res) => {
    log.debug("Request to /fortnite/api/storefront/v2/keychain");
    res.json(keychain);
});

app.get("/catalog/api/shared/bulk/offers", (req, res) => {
    log.debug("Request to /catalog/api/shared/bulk/offers");
    res.json({});
});

module.exports = app;
