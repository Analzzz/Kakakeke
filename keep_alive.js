const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('Bot is alive!');
});

app.listen(8080, () => {
    console.log('Keep-alive server is running on port 8080');
});
