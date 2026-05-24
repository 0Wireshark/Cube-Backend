const blessed = require('blessed');
const contrib = require('blessed-contrib');

let screen;
let log;
let stats;
let header;
let renderScheduled = false;

const theme = {
    primary: 'magenta',
    accent: 'magenta',
    text: 'white',
    muted: 'gray',
    success: 'green',
    danger: 'red'
};

function init() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log('CUBE Operations Console disabled: non-interactive terminal detected.');
        return;
    }

    screen = blessed.screen({
        smartCSR: true,
        title: 'CUBE - Operations Console',
        fullUnicode: true,
        mouse: true
    });

    const grid = new contrib.grid({rows: 12, cols: 12, screen: screen});

    header = grid.set(0, 0, 2, 12, blessed.box, {
        content: [
            '',
            ' {magenta-fg}{bold}CUBE OPERATIONS{/bold}{/magenta-fg} {gray-fg}::{/gray-fg} {white-fg}Backend runtime monitor{/white-fg} {gray-fg}:: live services, requests, and bot activity{/gray-fg}'
        ].join('\n'),
        tags: true,
        border: { type: 'line' },
        style: {
            fg: theme.text,
            bg: 'black',
            border: { fg: theme.primary }
        }
    });

    stats = grid.set(2, 0, 3, 12, blessed.box, {
        label: ' Runtime ',
        content: 'Loading...',
        tags: true,
        border: { type: 'line' },
        style: {
            fg: theme.text,
            bg: 'black',
            border: { fg: theme.primary },
            label: { fg: theme.primary }
        }
    });

    log = grid.set(5, 0, 6, 12, blessed.log, {
        fg: theme.text,
        label: ' Event Stream ',
        border: { type: 'line' },
        tags: true,
        style: {
            fg: theme.text,
            bg: 'black',
            border: { fg: theme.primary },
            label: { fg: theme.primary }
        },
        mouse: false,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
            ch: ' ',
            bg: theme.primary,
            fg: theme.primary
        }
    });

    const footer = grid.set(11, 0, 1, 12, blessed.box, {
        content: ' {magenta-fg}{bold}F1{/bold}{/magenta-fg} restart {gray-fg}|{/gray-fg} {magenta-fg}{bold}F5{/bold}{/magenta-fg} clear stream {gray-fg}|{/gray-fg} {magenta-fg}{bold}W/S{/bold}{/magenta-fg} scroll {gray-fg}|{/gray-fg} {magenta-fg}{bold}ESC/Q{/bold}{/magenta-fg} exit',
        tags: true,
        border: { type: 'line' },
        style: {
            fg: theme.text,
            bg: 'black',
            border: { fg: theme.primary }
        }
    });

    screen.key(['f1'], function() {
        
        return process.exit(0);
    });

    screen.key(['escape', 'q', 'C-c'], function(ch, key) {
        
        return process.exit(1);
    });

    screen.key(['f5'], function() {
        log.log('{magenta-fg}stream cleared{/magenta-fg}');
        screen.render();
    });

    
    screen.key(['w', 'W'], function() {
        log.scroll(-2);
        screen.render();
    });

    screen.key(['s', 'S'], function() {
        log.scroll(2);
        screen.render();
    });

    screen.render();
}

function renderSoon() {
    if (!screen || renderScheduled) return;

    renderScheduled = true;
    const timer = setTimeout(() => {
        renderScheduled = false;
        if (screen) screen.render();
    }, 50);

    if (timer.unref) timer.unref();
}

function addLog(message) {
    if (log && log.log) {
        log.log(message);
        renderSoon();
    } else {
        console.log(message);
    }
}

function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateStats(data) {
    if (stats) {
        const status = (label, value) => `{magenta-fg}{bold}${label}{/bold}{/magenta-fg} ${value}`;
        const online = '{green-fg}ONLINE{/green-fg}';
        const offline = '{red-fg}OFFLINE{/red-fg}';

        let content = '';
        content += ` ${status('API', data.port || 'N/A')}   {gray-fg}|{/gray-fg}   ${status('WEB', data.websitePort || 'N/A')}   {gray-fg}|{/gray-fg}   ${status('DB', data.database || 'Connecting...')}\n`;
        content += ` ${status('XMPP', data.xmpp ? online : offline)}   {gray-fg}|{/gray-fg}   ${status('BOT', data.bot ? online : offline)}   {gray-fg}|{/gray-fg}   ${status('PLAYERS', data.players || 0)}\n`;
        content += ` {gray-fg}uptime{/gray-fg} {magenta-fg}${formatUptime(process.uptime())}{/magenta-fg}`;
        
        stats.setContent(content);
        renderSoon();
    }
}

module.exports = {
    init,
    addLog,
    updateStats
};
