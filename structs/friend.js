const Friends = require("../model/friends.js");
const functions = require("../structs/functions.js");
const gifting = require("../structs/gifting.js");

function now() {
    return new Date().toISOString();
}

function normalizeList(document) {
    const list = document.list || {};
    list.accepted = Array.isArray(list.accepted) ? list.accepted : [];
    list.incoming = Array.isArray(list.incoming) ? list.incoming : [];
    list.outgoing = Array.isArray(list.outgoing) ? list.outgoing : [];
    list.blocked = Array.isArray(list.blocked) ? list.blocked : [];
    return list;
}

function has(list, type, accountId) {
    return list[type].some(entry => entry.accountId === accountId);
}

function add(list, type, accountId, extra = {}) {
    const existing = list[type].find(entry => entry.accountId === accountId);
    if (existing) return existing;

    const entry = { accountId, created: now(), ...extra };
    list[type].push(entry);
    return entry;
}

function remove(list, type, accountId) {
    const before = list[type].length;
    list[type] = list[type].filter(entry => entry.accountId !== accountId);
    return before !== list[type].length;
}

function removeEverywhere(list, accountId, includeBlocked = false) {
    let removed = false;
    for (const type of ["accepted", "incoming", "outgoing"]) {
        if (remove(list, type, accountId)) removed = true;
    }
    if (includeBlocked && remove(list, "blocked", accountId)) removed = true;
    return removed;
}

async function getPair(accountId, friendId) {
    const [sender, receiver] = await Promise.all([
        Friends.findOne({ accountId }),
        Friends.findOne({ accountId: friendId })
    ]);
    if (!sender || !receiver) return null;
    return { sender, receiver, senderList: normalizeList(sender), receiverList: normalizeList(receiver) };
}

function sendFriendUpdate(toAccountId, accountId, status, direction, created = now()) {
    functions.sendXmppMessageToId({
        payload: {
            accountId,
            status,
            direction,
            created,
            favorite: false
        },
        type: "com.epicgames.friends.core.apiobjects.Friend",
        timestamp: now()
    }, toAccountId);
}

function sendFriendRemoval(toAccountId, accountId, reason = "DELETED") {
    functions.sendXmppMessageToId({
        payload: {
            accountId,
            reason
        },
        type: "com.epicgames.friends.core.apiobjects.FriendRemoval",
        timestamp: now()
    }, toAccountId);
}

async function savePair(sender, senderList, receiver, receiverList) {
    await Promise.all([
        sender.updateOne({ $set: { list: senderList } }),
        receiver.updateOne({ $set: { list: receiverList } })
    ]);
}

async function validateFriendAdd(accountId, friendId) {
    if (accountId === friendId) return false;
    const pair = await getPair(accountId, friendId);
    if (!pair) return false;

    const { sender, receiver, senderList, receiverList } = pair;
    if (has(senderList, "accepted", receiver.accountId) || has(receiverList, "accepted", sender.accountId)) return false;
    if (has(senderList, "blocked", receiver.accountId) || has(receiverList, "blocked", sender.accountId)) return false;

    return true;
}

async function validateFriendDelete(accountId, friendId) {
    if (accountId === friendId) return false;
    return Boolean(await getPair(accountId, friendId));
}

async function validateFriendBlock(accountId, friendId) {
    if (accountId === friendId) return false;
    const pair = await getPair(accountId, friendId);
    if (!pair) return false;
    return !has(pair.senderList, "blocked", pair.receiver.accountId);
}

async function sendFriendReq(fromId, toId) {
    const pair = await getPair(fromId, toId);
    if (!pair) return false;

    const { sender, receiver, senderList, receiverList } = pair;
    if (!await validateFriendAdd(fromId, toId)) return false;

    add(senderList, "outgoing", receiver.accountId);
    add(receiverList, "incoming", sender.accountId);
    await savePair(sender, senderList, receiver, receiverList);

    sendFriendUpdate(sender.accountId, receiver.accountId, "PENDING", "OUTBOUND");
    sendFriendUpdate(receiver.accountId, sender.accountId, "PENDING", "INBOUND");
    return true;
}

async function acceptFriendReq(fromId, toId) {
    const pair = await getPair(fromId, toId);
    if (!pair) return false;

    const { sender, receiver, senderList, receiverList } = pair;
    if (has(senderList, "accepted", receiver.accountId) && has(receiverList, "accepted", sender.accountId)) return true;
    if (!has(senderList, "incoming", receiver.accountId) && !has(receiverList, "outgoing", sender.accountId)) return false;
    if (has(senderList, "blocked", receiver.accountId) || has(receiverList, "blocked", sender.accountId)) return false;

    removeEverywhere(senderList, receiver.accountId);
    removeEverywhere(receiverList, sender.accountId);
    const senderAccepted = add(senderList, "accepted", receiver.accountId);
    const receiverAccepted = add(receiverList, "accepted", sender.accountId);
    await savePair(sender, senderList, receiver, receiverList);

    sendFriendUpdate(sender.accountId, receiver.accountId, "ACCEPTED", "INBOUND", gifting.getClientGiftEligibleCreated(senderAccepted.created));
    sendFriendUpdate(receiver.accountId, sender.accountId, "ACCEPTED", "OUTBOUND", gifting.getClientGiftEligibleCreated(receiverAccepted.created));
    functions.getPresenceFromUser(sender.accountId, receiver.accountId, false);
    functions.getPresenceFromUser(receiver.accountId, sender.accountId, false);
    return true;
}

async function deleteFriend(fromId, toId) {
    const pair = await getPair(fromId, toId);
    if (!pair) return false;

    const { sender, receiver, senderList, receiverList } = pair;
    const removedFromSender = removeEverywhere(senderList, receiver.accountId);
    const removedFromReceiver = removeEverywhere(receiverList, sender.accountId);

    if (removedFromSender || removedFromReceiver) {
        await savePair(sender, senderList, receiver, receiverList);
        sendFriendRemoval(sender.accountId, receiver.accountId);
        sendFriendRemoval(receiver.accountId, sender.accountId);
    }

    return true;
}

async function blockFriend(fromId, toId) {
    const pair = await getPair(fromId, toId);
    if (!pair) return false;
    if (!await validateFriendBlock(fromId, toId)) return false;

    const { sender, receiver, senderList, receiverList } = pair;
    const removedFromSender = removeEverywhere(senderList, receiver.accountId);
    const removedFromReceiver = removeEverywhere(receiverList, sender.accountId);
    add(senderList, "blocked", receiver.accountId);
    await savePair(sender, senderList, receiver, receiverList);

    if (removedFromSender || removedFromReceiver) {
        sendFriendRemoval(sender.accountId, receiver.accountId);
        sendFriendRemoval(receiver.accountId, sender.accountId);
    }

    return true;
}

async function unblockFriend(fromId, toId) {
    const pair = await getPair(fromId, toId);
    if (!pair) return false;

    const { sender, receiver, senderList } = pair;
    remove(senderList, "blocked", receiver.accountId);
    await sender.updateOne({ $set: { list: senderList } });
    return true;
}

module.exports = {
    validateFriendAdd,
    validateFriendDelete,
    validateFriendBlock,
    sendFriendReq,
    acceptFriendReq,
    blockFriend,
    unblockFriend,
    deleteFriend
};
