/**
 * The examples of the recipe reader. Each one is a made-up page on an `.example` host. The page of
 * the tool reads the first one at build time.
 */

/** One example: the HTML and the URL of a page, and the inputs of the tool. */
export interface RecipeSample {
  readonly name: string;
  readonly url: string;
  readonly html: string;
  /** This text is the address of the venue, for a page that lists more than one location. */
  readonly location: string;
  /** These are the hours that an application keeps, in the notation of OpenStreetMap. */
  readonly kept: string;
}

export const RECIPE_SAMPLES: readonly RecipeSample[] = [
  {
    name: "A restaurant: the JSON-LD and the text disagree",
    url: "https://forno-esempio.example/",
    location: "",
    kept: "Tu-Su 07:00-15:00",
    html: `<!doctype html>
<html lang="en">
<head>
  <title>Forno Esempio · Wood-fired bread</title>
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Bakery","name":"Forno Esempio",
   "telephone":"+1-555-0100",
   "address":{"@type":"PostalAddress","streetAddress":"12 Via Esempio","addressLocality":"Springfield"},
   "openingHoursSpecification":[{"@type":"OpeningHoursSpecification",
     "dayOfWeek":["Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],
     "opens":"07:00","closes":"15:00"}]}
  </script>
</head>
<body>
  <nav><a href="/">Home</a> <a href="/menu">Menu</a> <a href="/visit">Hours &amp; Location</a></nav>
  <h1>Forno Esempio</h1>
  <p>Wood-fired bread, baked every morning before dawn.</p>
  <h2>Hours</h2>
  <p>Tuesday to Saturday: 7 am to 2 pm<br>Sunday: 8 am to 1 pm<br>Closed on Mondays</p>
  <h2>Brunch</h2>
  <p>Sat-Sun 10-1</p>
  <footer><p>12 Via Esempio, Springfield</p></footer>
</body>
</html>`,
  },
  {
    name: "A page with three locations",
    url: "https://caffe-campione.example/locations",
    location: "40 Corso Esempio",
    kept: "Mo-Fr 07:00-18:00; Sa 08:00-14:00",
    html: `<!doctype html>
<html lang="en">
<head>
  <title>Our cafés | Caffè Campione</title>
  <script type="application/ld+json">
  [{"@context":"https://schema.org","@type":"CafeOrCoffeeShop","name":"Caffè Campione Centro",
    "address":{"@type":"PostalAddress","streetAddress":"3 Piazza Esempio"},
    "openingHours":["Mo-Su 07:00-20:00"]},
   {"@context":"https://schema.org","@type":"CafeOrCoffeeShop","name":"Caffè Campione Corso",
    "address":{"@type":"PostalAddress","streetAddress":"40 Corso Esempio"},
    "openingHours":["Mo-Fr 07:00-18:00","Sa 08:00-15:00"]},
   {"@context":"https://schema.org","@type":"CafeOrCoffeeShop","name":"Caffè Campione Stazione",
    "address":{"@type":"PostalAddress","streetAddress":"1 Viale della Stazione"},
    "openingHours":["Mo-Fr 06:00-21:00"]}]
  </script>
</head>
<body>
  <h1>Our cafés</h1>
  <p>Three cafés in Springfield. The hours of each café are on its card.</p>
  <ul>
    <li>Centro, 3 Piazza Esempio</li>
    <li>Corso, 40 Corso Esempio</li>
    <li>Stazione, 1 Viale della Stazione</li>
  </ul>
</body>
</html>`,
  },
  {
    name: "A product with variants, a sale and related products",
    url: "https://bottega-campione.example/products/olio-esempio?variant=1l",
    location: "",
    kept: "",
    html: `<!doctype html>
<html lang="en">
<head>
  <title>Olio Esempio, extra virgin olive oil | Bottega Campione</title>
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product",
   "@id":"https://bottega-campione.example/products/olio-esempio",
   "url":"https://bottega-campione.example/products/olio-esempio",
   "name":"Olio Esempio","brand":{"@type":"Brand","name":"Bottega Campione"},
   "sku":"OLIO","gtin13":"8001234567896",
   "image":"https://bottega-campione.example/img/olio.jpg",
   "hasVariant":[
     {"@type":"Product","name":"Olio Esempio, 500 ml","sku":"OLIO-500",
      "offers":{"@type":"Offer","url":"https://bottega-campione.example/products/olio-esempio?variant=500ml",
        "price":"12,50","priceCurrency":"EUR","availability":"https://schema.org/InStock"}},
     {"@type":"Product","name":"Olio Esempio, 1 l","sku":"OLIO-1L",
      "offers":{"@type":"Offer","url":"https://bottega-campione.example/products/olio-esempio?variant=1l",
        "priceCurrency":"EUR","availability":"https://schema.org/LimitedAvailability",
        "priceSpecification":[
          {"@type":"UnitPriceSpecification","priceType":"https://schema.org/StrikethroughPrice","price":"24,00","priceCurrency":"EUR"},
          {"@type":"UnitPriceSpecification","price":"21,00","priceCurrency":"EUR"}]}},
     {"@type":"Product","name":"Olio Esempio, 5 l","sku":"OLIO-5L",
      "offers":{"@type":"Offer","url":"https://bottega-campione.example/products/olio-esempio?variant=5l",
        "price":"89,00","priceCurrency":"EUR","availability":"https://schema.org/OutOfStock"}}]}
  </script>
  <script type="application/ld+json">
  [{"@context":"https://schema.org","@type":"Product","name":"Aceto Esempio, 250 ml",
    "url":"https://bottega-campione.example/products/aceto-esempio",
    "description":"A balsamic vinegar aged for twelve years in oak and cherry barrels, from the same family as our oil.",
    "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"212"},
    "review":[{"@type":"Review","author":{"@type":"Person","name":"A. Reader"},"reviewRating":{"@type":"Rating","ratingValue":"5"},"reviewBody":"Thick and sweet, very good on cheese and on strawberries."},
              {"@type":"Review","author":{"@type":"Person","name":"B. Reader"},"reviewRating":{"@type":"Rating","ratingValue":"5"},"reviewBody":"The bottle is small, but a little goes a long way."},
              {"@type":"Review","author":{"@type":"Person","name":"C. Reader"},"reviewRating":{"@type":"Rating","ratingValue":"4"},"reviewBody":"Good with a risotto. The cap leaks a little when the bottle is full."},
              {"@type":"Review","author":{"@type":"Person","name":"D. Reader"},"reviewRating":{"@type":"Rating","ratingValue":"5"},"reviewBody":"We buy it each winter. The twelve years show in the taste."},
              {"@type":"Review","author":{"@type":"Person","name":"E. Reader"},"reviewRating":{"@type":"Rating","ratingValue":"5"},"reviewBody":"A gift for my parents, and now they ask for it each month."},
              {"@type":"Review","author":{"@type":"Person","name":"F. Reader"},"reviewRating":{"@type":"Rating","ratingValue":"4"},"reviewBody":"Very good, but the price went up since last year."}],
    "offers":{"@type":"Offer","price":"18,00","priceCurrency":"EUR","availability":"https://schema.org/InStock"}},
   {"@context":"https://schema.org","@type":"Product","name":"Sale Marino, 1 kg",
    "url":"https://bottega-campione.example/products/sale-marino",
    "offers":{"@type":"Offer","price":"4,20","priceCurrency":"EUR"}}]
  </script>
</head>
<body>
  <h1>Olio Esempio</h1>
  <p>Extra virgin olive oil from one grove. 1 l: <s>24,00 €</s> 21,00 €. Few bottles left.</p>
  <h2>You may also like</h2>
  <ul><li>Aceto Esempio, 250 ml: 18,00 €</li><li>Sale Marino, 1 kg: 4,20 €</li></ul>
</body>
</html>`,
  },
  {
    name: "A wall: the shop sends a bot check",
    url: "https://negozio-campione.example/products/tazza",
    location: "",
    kept: "",
    html: `<!doctype html>
<html lang="en">
<head><title>Just a moment...</title></head>
<body>
  <h1>negozio-campione.example</h1>
  <p>Checking your browser before you access negozio-campione.example.</p>
  <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
</body>
</html>`,
  },
];
