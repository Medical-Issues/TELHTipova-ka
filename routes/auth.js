const path = require('path');
const bcrypt = require("bcrypt");
const express = require("express");
const router = express.Router();
const { renderErrorHtml } = require("../utils/fileUtils");

const { Users } = require('../utils/mongoDataAccess');
router.get("/register", (req, res) => {
    res.sendFile(path.join(__dirname, "../views/register.html"));
});
router.post("/register", async (req, res) => {
    const {username, password} = req.body;
    
    // Kontrola existence uživatele v MongoDB
    const existingUser = await Users.findOne({ username });
    
    if (existingUser) {
        return res.redirect('/auth/register?error=1');
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            username,
            password: hashedPassword,
            role: "user",
            correct: 0,
            total: 0
        };
        
        // Uložení do MongoDB
        await Users.insertOne(newUser);
        
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
    
    // Načtení uživatele z MongoDB
    const user = await Users.findOne({ username });

    if (!user) {
        return res.redirect('/auth/login?error=1');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
        return res.redirect("/auth/login?error=1");
    }

    req.session.user = username;
    req.session.role = user.role || "user";

    req.session.save((err) => {
        if (err) {
            console.error('Chyba při ukládání session:', err);
            return renderErrorHtml(res, "Nastala chyba při přihlášení.");
        }

        res.redirect('/');

    });
});

router.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect('/auth/login');
    });
});

module.exports = router;

