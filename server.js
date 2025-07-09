const express = require('express');
const path = require('path');
const bodyParser = require("body-parser");
const session = require("express-session");
const FileStore = require('session-file-store')(session);
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({extended: true}));
app.use(session({
    store: new FileStore({}),
    secret: 'tajnyklic',
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 30,
    }
}));

app.use('/auth', authRoutes);
app.use('/', userRoutes)
app.use('/admin', adminRoutes);

app.listen(3000, () => {
    console.log('Server běží na http://localhost:3000');
});
