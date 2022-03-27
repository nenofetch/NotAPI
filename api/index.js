import "dotenv/config";
import {resolve} from "path";
import {randomBytes} from "crypto";
import {performance} from "perf_hooks";

// express
import express from "express";
import {configure, renderFile} from "eta";
//import minifyHTML from "express-minify-html-terser";
//import compression from "compression";
import helmet from "helmet";
import permissionsPolicy from "permissions-policy";
import useragent from "express-useragent";

// helpers/utilities
import fetch from "node-fetch";
import {Telegraf} from "telegraf";
import pify from "pify";
import delay from "delay";
import PQueue from "p-queue";
import Cron from "croner";
import geoip from "geoip-lite";

// API dependency
import morse from "morse-decoder";
import romans from "romans";
import {Client as Genius} from "genius-lyrics";
const genius = new Genius(process.env.GENIUS_API);

// Environment
let {NODE_ENV, BOT_TOKEN, WEBHOOK_SERVER, WEBHOOK_SECRET_PATH, BOTLOG_CHATID, IP_BLACKLIST, UA_BLACKLIST} = process.env;
const IS_PROD = Boolean(NODE_ENV) && NODE_ENV == "production";
const IPS_BLACKLIST = (Boolean(IP_BLACKLIST) && IP_BLACKLIST.split(" ").filter(Boolean)) || [];
const UAS_BLACKLIST = (Boolean(UA_BLACKLIST) && UA_BLACKLIST.split(" ").filter(Boolean)) || [];

// Telegram Bot API
const StartTime = Date.now();
const tl = new Telegraf(BOT_TOKEN);
const tl_secret = `/${WEBHOOK_SECRET_PATH}/${tl.secretPathComponent()}`;

// REST API rate limiter
const queue = new PQueue({concurrency: 3});

// Global nonce
const ranuid = randomBytes(9).toString("hex");

const app = express();
//const router = express.Router();
app.set("trust proxy", true);
app.use(express.urlencoded({extended: true}));
app.use(express.json());
app.use((req, res, next) => {
    res.locals.nonce = ranuid;
    res.locals.baseURL = getURL(req, false);
    res.locals.canonicalURL = getURL(req, true);
    next();
});
configure({
    async: true,
    cache: IS_PROD,
    tags: ["{{", "}}"],
    varName: "it",
});
app.engine("html", renderFile);
app.set("view engine", "html");
app.set("views", resolve("views"));
app.use(
    express.static(resolve("public"), {
        index: false,
        etag: false,
        maxAge: "30 days",
    }),
    /*
    minifyHTML({
        override: true,
        exception_url: false,
        htmlMinifier: {
            removeComments: true,
            collapseWhitespace: true,
            collapseBooleanAttributes: true,
            removeAttributeQuotes: false,
            removeEmptyAttributes: true,
            minifyJS: true,
            minifyCSS: true,
        },
    }),
    compression(),*/
    helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "cdn.jsdelivr.net"],
                imgSrc: ["'self'"],
                styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: [],
            },
        },
        dnsPrefetchControl: {allow: true},
    }),
    permissionsPolicy({
        features: {
            accelerometer: [],
            camera: [],
            geolocation: [],
            gyroscope: [],
            magnetometer: [],
            microphone: [],
            payment: [],
            usb: [],
            interestCohort: [],
        },
    }),
    useragent.express(),
    (req, res, next) => {
        const ip = req.ip;
        const ua = req.useragent;
        const uam = {
            browser: ua.browser,
            version: ua.version,
            os: ua.os,
            platform: ua.platform,
            source: ua.source,
        };
        delete req.useragent;
        if (ip == "127.0.0.1" || ip == "::1" || ip == "::ffff:127.0.0.1") {
            res.locals.u = {ip, ...uam};
        } else {
            const {range, eu, ll, metro, area, ...geo} = geoip.lookup(ip);
            res.locals.u = {ip, ...geo, ...uam};
        }
        next();
    },
);

function getURL(req, canonical = false) {
    const url = canonical ? `https://${req.headers.host}${req.originalUrl}` : `https://${req.headers.host}`;
    return url.replace(/\/+$/, "").toLowerCase().trim();
}

function setNoCache(res) {
    const date = new Date();
    date.setFullYear(date.getFullYear() - 1);
    res.set("Expires", date.toUTCString());
    res.set("Pragma", "no-cache");
    res.set("Cache-Control", "public, no-cache");
}

async function renderPage(req, res, template) {
    res.set("Content-Type", "text/html");
    res.set("Cache-Control", "public, max-age=2592000"); // 30 days
    return void res.render("index", {
        ...{
            nonce: res.locals.nonce,
            baseURL: res.locals.baseURL,
            canonicalURL: res.locals.canonicalURL,
        },
        ...template,
    });
}

async function NotAPI(req, res) {
    let data = {};
    let is_api = false;
    const {api} = req.params;
    const {en, de, id, q} = req.query;
    await delay.range(150, 500);
    // morse code
    if (api == "morse") {
        if (en) {
            is_api = true;
            data["input"] = `${en}`;
            try {
                const result = await pify(morse.encode, {excludeMain: true})(en);
                data["result"] = `${result}`;
            } catch (err) {
                data["result"] = err.message;
            }
        }
        if (de) {
            is_api = true;
            data["input"] = `${de}`;
            try {
                const result = await pify(morse.decode, {excludeMain: true})(de);
                data["result"] = `${result}`;
            } catch (err) {
                data["result"] = err.message;
            }
        }
    }
    // romans numerals
    if (api == "romans") {
        if (en) {
            is_api = true;
            data["input"] = `${en}`;
            try {
                const result = await pify(romans.romanize, {excludeMain: true})(+`${en}`);
                data["result"] = `${result}`;
            } catch (err) {
                data["result"] = err.message;
            }
        }
        if (de) {
            is_api = true;
            data["input"] = `${de}`;
            try {
                const result = await pify(romans.deromanize, {excludeMain: true})(de);
                data["result"] = `${result}`;
            } catch (err) {
                data["result"] = err.message;
            }
        }
    }
    // spamwatch check banned user
    if (api == "spamwatch") {
        if (id) {
            is_api = true;
            try {
                const url = `https://api.spamwat.ch/banlist/${id}`;
                const headers = {Authorization: `Bearer ${process.env.SPAMWATCH_API}`};
                const ban = await fetch(url, {headers}).then((x) => x.json());
                ban.date = new Date(ban.date * 1000);
                data["error"] = "";
                data = {...data, ...ban};
            } catch (err) {
                data["error"] = err.message;
            }
        }
    }
    // genius lyrics search
    if (api == "lyrics") {
        if (q) {
            is_api = true;
            try {
                const searches = await genius.songs.search(q);
                const song = searches[0];
                const lyrics = await song.lyrics();
                data["error"] = "";
                data["title"] = `${song.title}`;
                data["artist"] = `${song.artist.name}`;
                data["url"] = `${song.url}`;
                data["lyrics"] = `${lyrics}`;
            } catch (err) {
                data["error"] = err.message;
            }
        }
    }
    return {is_api, data};
}

async function queueNotAPI(req, res) {
    return queue.add(() => NotAPI(req, res));
}

const ping = new Cron("0 0 */6 * * *", {maxRuns: Infinity, paused: true}, async () => {
    try {
        await fetch(WEBHOOK_SERVER, {timeout: 3000}); // 6 hours
    } catch (_) {}
});

async function webhookInit() {
    if (IS_PROD) {
        try {
            await tl.telegram.deleteWebhook();
        } catch (_) {}
        try {
            await tl.telegram.setWebhook(`${WEBHOOK_SERVER.replace(/\/+$/, "")}${tl_secret}`);
        } catch (_) {}
    } else {
        const me = await tl.telegram.getMe();
        console.log(me);
    }
}

async function notify(res, api, data) {
    let user = "";
    let result = JSON.stringify(data, null, 2);
    for (const [key, val] of Object.entries(res.locals.u)) {
        user += `<b>${key.toUpperCase()}:</b> <code>${val}</code>\n`;
    }
    try {
        if (result.length < 4096) {
            await tl.telegram.sendMessage(BOTLOG_CHATID, `<pre>${result}</pre>\n\n${user}`, {parse_mode: "html"});
        } else {
            const plain = user.replace(new RegExp("<[^>]*>", "g"), "");
            const filename = `${api}_${+res.locals.u["ip"].split("").filter(parseInt).join("")}.txt`;
            const data = `${result}\n\n${plain}`;
            const source = Buffer.from(data);
            const headers = {
                filename,
                source,
            };
            await tl.telegram.sendDocument(BOTLOG_CHATID, headers);
        }
    } catch (_) {
        try {
            await tl.telegram.sendMessage(BOTLOG_CHATID, `<pre>${_}</pre>\n\n${user}`, {parse_mode: "html"});
        } catch (__) {}
    }
}

function getUptime(uptime) {
    let totals = uptime / 1000;
    const days = Math.floor(totals / 86400);
    totals %= 86400;
    const hours = Math.floor(totals / 3600);
    totals %= 3600;
    const minutes = Math.floor(totals / 60);
    const seconds = Math.floor(totals % 60);
    return `${days}d:${hours}h:${minutes}m:${seconds}s`;
}

function checkTime(ctx, next) {
    switch (ctx.updateType) {
        case "message":
            if (new Date().getTime() / 1000 - ctx.message.date < 5 * 60) {
                return next();
            }
            break;
        case "callback_query":
            if (ctx.callbackQuery.message && new Date().getTime() / 1000 - ctx.callbackQuery.message.date < 5 * 60) {
                return next();
            }
            break;
        default:
            return next();
    }
}

tl.use(checkTime);
tl.command("ping", async (ctx) => {
    const start = performance.now();
    const chat_id = ctx.message.chat.id;
    const msg_id = ctx.message.message_id;
    const reply = await ctx.telegram.sendMessage(chat_id, "Ping !", {reply_to_message_id: msg_id});
    const end = performance.now();
    const ms = Number((end - start) / 1000).toFixed(2);
    const up = getUptime(Date.now() - StartTime);
    await ctx.telegram.editMessageText(
        reply.chat.id,
        reply.message_id,
        undefined,
        `🏓 Pong !!\n<b>Speed</b> - <code>${ms}ms</code>\n<b>Uptime</b> - <code>${up}</code>`,
        {parse_mode: "html"},
    );
});
tl.on("message", (ctx, next) => {
    if (ctx.update.message.chat.type !== "private") {
        return next();
    }
    const SKIP = ["/ping"];
    if (ctx.update.message.text && SKIP.some((x) => ctx.update.message.text.toLowerCase().includes(x))) {
        return next();
    }
    const chat_id = ctx.message.chat.id;
    const msg_id = ctx.message.message_id;
    const raw = JSON.stringify(ctx.message, null, 2);
    ctx.telegram.sendMessage(chat_id, `<pre>${raw}</pre>`, {
        parse_mode: "html",
        reply_to_message_id: ctx.message.message_id,
    });
});

app.get("/", async (req, res) => {
    const template = {
        page: {
            title: "NotAPI",
            description: "A simple multi-featured API",
            robots: "index,follow",
        },
        title: "NotAPI",
        description: `A simple multi-featured API by <a href="https://github.com/notudope" title="GitHub @notudope">@notudope</a><br>How to use <a href="https://github.com/notudope/NotAPI" title="GitHub NotAPI">→ read here...</a>`,
    };
    res.status(200);
    await renderPage(req, res, template);
});

app.get("/api/:api", async (req, res, next) => {
    if (UAS_BLACKLIST.some((x) => res.locals.u.source.toLowerCase().includes(x))) {
        return res.status(403).send("Bot not allowed.");
    }
    if (IPS_BLACKLIST.includes(req.ip)) {
        return next();
    }
    if (req.params.api) {
        const {is_api, data} = await queueNotAPI(req, res);
        if (is_api) {
            ping.pause();
            res.set("Access-Control-Allow-Methods", "GET, POST");
            res.set("Access-Control-Allow-Headers", "content-type");
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Credentials", "true");
            res.set("Content-Type", "application/json");
            setNoCache(res);
            res.status(200);
            await notify(res, req.params.api, data);
            ping.resume();
            return res.json({...data});
        }
    }
    return res.status(320).redirect("/");
});

app.use(tl.webhookCallback(tl_secret));

app.all("*", async (req, res) => {
    const template = {
        page: {
            title: "404 - NotAPI",
            description: "Page not found",
            robots: "noindex",
        },
        title: "404",
        description: "Didn't find anything here!",
    };
    res.status(404);
    await renderPage(req, res, template);
});

if (!IS_PROD) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, async () => console.log(`🚀 Server listening on http://127.0.0.1:${PORT}`));
}

(async () => {
    await webhookInit();
    if (IS_PROD) {
        ping.resume();
    }
})();

export default app;
