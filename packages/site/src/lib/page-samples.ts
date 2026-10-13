/** The examples of the page reader. The page reads the first one at build time. */
export const PAGE_SAMPLES: ReadonlyArray<{
  readonly name: string;
  readonly url: string;
  readonly html: string;
}> = [
  {
    name: "A restaurant with JSON-LD",
    url: "https://forno.example/",
    html: `<!doctype html>
<html lang="en">
<head>
  <title>Forno Esempio · Wood-fired bread</title>
  <meta name="description" content="A neighborhood bakery.">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Bakery","name":"Forno Esempio",
   "telephone":"+1-555-0100","openingHours":["Tu-Su 07:00-15:00"],
   "address":{"@type":"PostalAddress","streetAddress":"12 Main St","addressLocality":"Springfield"}}
  </script>
</head>
<body>
  <nav><a href="/">Home</a> <a href="/menu">Menu</a> <a href="/hours-location">Hours &amp; Location</a></nav>
  <h1>Forno Esempio</h1>
  <p>Wood-fired bread, baked every morning before dawn.</p>
  <footer><p>Tuesday to Sunday, 7am to 3pm</p><p>12 Main St</p></footer>
</body>
</html>`,
  },
  {
    name: "An app shell",
    url: "https://app.example/venue/42",
    html: `<!doctype html>
<html lang="en">
<head><title>Book a table</title></head>
<body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <div id="root"></div>
  <script src="/static/js/main.4f2a.js"></script>
</body>
</html>`,
  },
  {
    name: "Hours in a table",
    url: "https://museum.example/visit",
    html: `<!doctype html>
<html lang="en">
<head><title>Visit the museum</title></head>
<body>
  <h1>Plan your visit</h1>
  <table>
    <tr><td>Monday</td><td>10 am–5 pm</td></tr>
    <tr><td>Tuesday</td><td>Closed</td></tr>
    <tr><td>Wednesday</td><td>10 am–5 pm</td></tr>
    <tr><td>Thursday–Friday</td><td>10 am–10 pm</td></tr>
  </table>
  <p>Tickets <a href="/tickets">online</a> or at the door.</p>
</body>
</html>`,
  },
  {
    name: "A bot check",
    url: "https://shop.example/product/7",
    html: `<!doctype html>
<html lang="en">
<head><title>Just a moment...</title></head>
<body>
  <h1>shop.example</h1>
  <p>Checking your browser before you access shop.example.</p>
  <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
</body>
</html>`,
  },
  {
    name: "A page that moved",
    url: "https://old.example/menu",
    html: `<!doctype html>
<html lang="en">
<head>
  <title>Our menu moved</title>
  <meta http-equiv="refresh" content="0; url=https://old.example/food/menu">
  <link rel="canonical" href="https://old.example/food/menu">
</head>
<body><p>The menu moved. <a href="/food/menu">Open the new menu</a>.</p></body>
</html>`,
  },
];
