const path = require('path');
const fs = require("fs");
const bcrypt = require("bcrypt");
const express = require("express");
const router = express.Router();
const { renderErrorHtml } = require("../utils/fileUtils");

router.get("/register", (req, res) => {
    res.sendFile(path.join(__dirname, "../views/register.html"));
});
router.post("/register", async (req, res) => {
    const {username, password} = req.body;
    const users = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));

    if (users.find(u => u.username === username)) {
        return res.redirect('/auth/register?error=1');
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        users.push(
            {
                username,
                password: hashedPassword,
                correct: 0,
                total: 0
            }
        );
        fs.writeFileSync('./data/users.json', JSON.stringify(users, null, 2));
        res.redirect('/auth/login');
    } catch (err) {
        console.error(err);
        renderErrorHtml(res, "Při registraci nastala chyba. Zkuste to prosím později.");
    }
});

router.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "../views/login.html"));
});

router.post('/login', async (req, res) => {
    const {username, password} = req.body;
    const users = JSON.parse(fs.readFileSync('data/users.json', 'utf8'));
    const user = users.find(u => u.username === username);

    if (!user) {
        return res.redirect('/auth/login?error=1');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
        return res.redirect("/auth/login?error=1");
    }

    req.session.user = username;

    req.session.save((err) => {
        if (err) {
            console.error('Chyba při ukládání session:', err);
            return renderErrorHtml(res, "Nastala chyba při přihlášení.");
        }
    });
});

router.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect('/auth/login');
    });
});

module.exports = router;