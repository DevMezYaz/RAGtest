// Landing stack: one entry per folder, back (top) to front (bottom).
export const FOLDERS = [
  { color: "#1f3de0", right: "Organic & Daily Modernism", tabs: [
    { id: "flw", label: "Frank Lloyd Wright", color: "#1f3de0", x: 0 },
    { id: "gill", label: "Irving Gill", color: "#d91f26", x: 17.5 } ] },
  { color: "#0d6b3d", right: "Expressive", tabs: [{ id: "gehry", label: "Frank Gehry", color: "#0d6b3d", x: 0.4 }] },
  { color: "#5b2a7a", right: "Monumental & Brutalist", tabs: [
    { id: "kahn", label: "Louis Kahn", color: "#5b2a7a", x: 0 },
    { id: "pei", label: "I. M. Pei", color: "#f2e30c", ink: "#111", x: 14.5 },
    { id: "rudolph", label: "Paul Rudolph", color: "#0b0b0b", x: 27.5 } ] },
  { color: "#46195f", right: "Early American Foundations", tabs: [
    { id: "colter", label: "Mary Colter", color: "#46195f", x: 0 },
    { id: "sullivan", label: "Louis Sullivan", color: "#d91f26", x: 17.5 } ] },
  { color: "#c4202b", right: "Contextual & Transitional Architecture", tabs: [] },
];

const P = (title, year, text, art) => ({ title, year, text, art });

export const ARCH = {
  flw: {
    name: "Frank Lloyd Wright", color: "#1f3de0", next: "gill",
    intro: "Frank Lloyd Wright redefined architecture from the inside out. To him, walls and roofs were secondary — the real essence was space: shaped for life, movement, and use. Form, he argued, must follow the rhythm of living.",
    body: "He pioneered organic architecture: not in metaphor, but in method. The building emerged from its site, rooted in it, inseparable from its ground. His Usonian houses, devoid of ornament, made simplicity a critical virtue — standardized, yet never anonymous.",
    born: "June 8, 1867, Richland Center, Wisconsin", died: "April 9, 1959 (age 91)",
    quote: "the tyranny of the box: dissolving sightlines, letting rooms unfold…",
    quoteBody: "Rooms flow into one another under low, sheltering eaves. Light is drawn in and held, and the hearth sits at the heart of the plan, so that the whole house gathers around a single point of rest.",
    projects: [
      P("Fallingwater", 1935, "Wright’s masterstroke of organic architecture. Cantilevered slabs hover over a running stream.", "fallingwater"),
      P("Robie House", 1910, "Low, horizontal planes and deep eaves define the Prairie School ideal: a house that belongs to the plains.", "robie"),
    ],
    film: "An Interview with Frank Lloyd Wright, 1958",
  },
  gill: {
    name: "Irving Gill", color: "#d91f26", next: "gehry",
    intro: "Irving Gill stripped the house to its essentials: smooth white walls, unbroken arches, and the clean line of a Californian horizon. His work anticipated European Modernism by a decade.",
    body: "Working in San Diego, he poured concrete into plain cubes and let sunlight do the ornamenting. Simplicity became both an aesthetic and an ethic for everyday living.",
    born: "April 26, 1870, Tully, New York", died: "October 7, 1936 (age 66)",
    quote: "a house of cubes, arches and light…", quoteBody: "Gill believed a wall should be as plain as a sheet of paper, and that shadow is the only decoration a building needs.",
    projects: [P("Dodge House", 1916, "A white concrete monolith, once a landmark of the new California.", "robie"), P("La Jolla Women’s Club", 1914, "Arches repeated into rhythm, shade, and calm.", "fallingwater")],
    film: "Irving Gill — a retrospective",
  },
};
const generic = (name, color, next, born, died, line) => ({
  name, color, next,
  intro: `${name} ${line}`,
  body: "Placeholder copy: the original page’s text for this architect isn’t in the reference frames. Replace this block in web/mosby/data.js.",
  born, died, quote: "an American path of functionalism…", quoteBody: "Placeholder copy — edit in data.js.",
  projects: [P("Selected work", "—", "Placeholder project card.", "robie"), P("Later work", "—", "Placeholder project card.", "fallingwater")],
  film: `${name} — film placeholder`,
});
ARCH.gehry = generic("Frank Gehry", "#0d6b3d", "kahn", "1929, Toronto", "—", "bent the American box into sculpture, letting steel and titanium ripple like cloth.");
ARCH.kahn = generic("Louis Kahn", "#5b2a7a", "pei", "1901, Kuressaare", "1974, New York", "gave concrete and brick a monumental silence, composing with light and mass.");
ARCH.pei = generic("I. M. Pei", "#f2e30c", "rudolph", "1917, Guangzhou", "2019, New York", "worked in sharp geometry and luminous stone, bridging old cities and new forms.");
ARCH.rudolph = generic("Paul Rudolph", "#0b0b0b", "colter", "1918, Elkton, Kentucky", "1997, New York", "stacked concrete into dramatic, many-levelled interiors.");
ARCH.colter = generic("Mary Colter", "#46195f", "sullivan", "1869, Pittsburgh", "1958, Santa Monica", "shaped the Southwest’s railway landscape from local stone and memory.");
ARCH.sullivan = generic("Louis Sullivan", "#d91f26", "flw", "1856, Boston", "1924, Chicago", "coined “form follows function” and wrapped the early skyscraper in living ornament.");
