async function sendUserDm(user, payload) {
    try {
        await user.send(payload);
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = sendUserDm;
