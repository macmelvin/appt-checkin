// Waypoint — a clean, ad-free directions app.
// Geocoding: OneMap (Singapore's official government geocoder, via our own
// /api/geocode proxy) for place/address/postal-code search. Reverse geocoding
// ("what's near my current GPS position") still uses Nominatim, since that
// direction isn't prone to the ambiguous/under-construction-POI problem OneMap
// fixed for forward search. Routing: OSRM public demo server (driving/cycling/
// walking) and OpenTripPlanner via /api/transit-plan (bus/MRT).

let fromCoords = null; // { lat, lon, label }
let toCoords = null;
let selectedMode = 'driving';
let hasRoute = false; // whether a route/itinerary is currently displayed (for mode-switch auto-refresh)

// Which OSRM backend + profile name to use per travel mode. See the comment
// in getDirections() for why driving/cycling/walking don't all hit the same host.
const OSRM_ENDPOINTS = {
  driving: { host: 'https://router.project-osrm.org', profile: 'driving' },
  cycling: { host: 'https://routing.openstreetmap.de/routed-bike', profile: 'bike' },
  walking: { host: 'https://routing.openstreetmap.de/routed-foot', profile: 'foot' },
};

const els = {
  langBtn: document.getElementById('langBtn'),
  searchInput: document.getElementById('searchInput'),
  searchClear: document.getElementById('searchClear'),
  searchResults: document.getElementById('searchResults'),
  categoryRow: document.getElementById('categoryRow'),
  placeCard: document.getElementById('placeCard'),
  placeName: document.getElementById('placeName'),
  placeAddress: document.getElementById('placeAddress'),
  dirFromHere: document.getElementById('dirFromHere'),
  dirToHere: document.getElementById('dirToHere'),
  setHomeBtn: document.getElementById('setHomeBtn'),
  setWorkBtn: document.getElementById('setWorkBtn'),
  quickHomeBtn: document.getElementById('quickHomeBtn'),
  quickWorkBtn: document.getElementById('quickWorkBtn'),
  fromInput: document.getElementById('fromInput'),
  toInput: document.getElementById('toInput'),
  fromResults: document.getElementById('fromResults'),
  toResults: document.getElementById('toResults'),
  swapBtn: document.getElementById('swapBtn'),
  getDirectionsBtn: document.getElementById('getDirectionsBtn'),
  routeSummary: document.getElementById('routeSummary'),
  routeSteps: document.getElementById('routeSteps'),
  itineraryOptionsLabel: document.getElementById('itineraryOptionsLabel'),
  itineraryOptions: document.getElementById('itineraryOptions'),
  rainBanner: document.getElementById('rainBanner'),
  rainBannerText: document.getElementById('rainBannerText'),
  trainAlertBanner: document.getElementById('trainAlertBanner'),
  trainAlertText: document.getElementById('trainAlertText'),
  trainAlertDismiss: document.getElementById('trainAlertDismiss'),
  parkingInfo: document.getElementById('parkingInfo'),
  evChargingInfo: document.getElementById('evChargingInfo'),
  petrolInfo: document.getElementById('petrolInfo'),
  erpInfo: document.getElementById('erpInfo'),
  trafficInfo: document.getElementById('trafficInfo'),
  cyclingExtra: document.getElementById('cyclingExtra'),
  startNavBtn: document.getElementById('startNavBtn'),
  navBanner: document.getElementById('navBanner'),
  navBannerIcon: document.getElementById('navBannerIcon'),
  navBannerDistance: document.getElementById('navBannerDistance'),
  navBannerInstruction: document.getElementById('navBannerInstruction'),
  navMuteBtn: document.getElementById('navMuteBtn'),
  navStopBtn: document.getElementById('navStopBtn'),
  navMapOverlay: document.getElementById('navMapOverlay'),
  navRecenterBtn: document.getElementById('navRecenterBtn'),
  navSpeedBadge: document.getElementById('navSpeedBadge'),
  navSpeedValue: document.getElementById('navSpeedValue'),
  navCompass: document.getElementById('navCompass'),
  navCompassNeedle: document.getElementById('navCompassNeedle'),
  navBottomSheet: document.getElementById('navBottomSheet'),
  navEta: document.getElementById('navEta'),
  navRemainingDuration: document.getElementById('navRemainingDuration'),
  navRemainingDistance: document.getElementById('navRemainingDistance'),
  parkedCarCard: document.getElementById('parkedCarCard'),
  parkedCarAgo: document.getElementById('parkedCarAgo'),
  parkedCarDistance: document.getElementById('parkedCarDistance'),
  parkedCarDirectionsBtn: document.getElementById('parkedCarDirectionsBtn'),
  parkedCarClearBtn: document.getElementById('parkedCarClearBtn'),
  saveParkingBtn: document.getElementById('saveParkingBtn'),
  locateBtn: document.getElementById('locateBtn'),
  locateBtnIcon: document.getElementById('locateBtnIcon'),
  offlineBanner: document.getElementById('offlineBanner'),
  notifyBtn: document.getElementById('notifyBtn'),
  weatherWidget: document.getElementById('weatherWidget'),
  weatherPanel: document.getElementById('weatherPanel'),
  weatherPanelBody: document.getElementById('weatherPanelBody'),
  weatherPanelClose: document.getElementById('weatherPanelClose'),
  toast: document.getElementById('toast'),
  tabs: document.querySelectorAll('.tab-btn'),
  panels: document.querySelectorAll('.panel'),
  modeButtons: document.querySelectorAll('.mode-btn'),
  wakeAlert: document.getElementById('wakeAlert'),
  wakeAlertText: document.getElementById('wakeAlertText'),
  wakeAlertDismiss: document.getElementById('wakeAlertDismiss'),
  shareBtn: document.getElementById('shareBtn'),
  installBanner: document.getElementById('installBanner'),
  installBtn: document.getElementById('installBtn'),
  installDismissBtn: document.getElementById('installDismissBtn'),
  nearbyStopsBtn: document.getElementById('nearbyStopsBtn'),
  favSearchInput: document.getElementById('favSearchInput'),
  favSearchResults: document.getElementById('favSearchResults'),
  favList: document.getElementById('favList'),
  favEmptyHint: document.getElementById('favEmptyHint'),
};

let currentPlace = null; // last searched place result

// ---------- Utilities ----------

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function showToast(msg, ms = 2500) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

// Turns a GeolocationPositionError into an actionable message instead of a
// generic "Could not get your location" for every possible cause — permission
// denial, no GPS/wifi fix available, and a timeout all need different fixes
// from the user, and code 0 ("Geolocation is not supported...") is handled
// separately by each caller before this ever runs.
function geoErrorMessage(err) {
  switch (err && err.code) {
    case 1: // PERMISSION_DENIED
      return 'Location access is blocked for this site — check your browser/site permissions and allow location, then try again.';
    case 2: // POSITION_UNAVAILABLE
      return 'Could not get a location fix — try again with GPS/Wi-Fi on, ideally outdoors.';
    case 3: // TIMEOUT
      return 'Location request timed out — try again.';
    default:
      return 'Could not get your location.';
  }
}

const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 };

async function geocode(query) {
  if (!query || query.trim().length < 2) return [];
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error('geocode failed');
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

// Results can come from two shapes: OneMap forward-search results ({ label,
// address, lat, lon }, already short/clean — no OSM-style comma-hierarchy to
// trim) or a Nominatim reverse-geocode result ({ display_name }) from the
// "use my location" button.
function shortLabel(result) {
  if (result.label) return result.label;
  if (result.display_name) return result.display_name.split(',').slice(0, 2).join(',').trim();
  return '';
}

function addressText(result) {
  return result.address || result.display_name || '';
}

// ---------- Tabs ----------

els.tabs.forEach(btn => {
  btn.addEventListener('click', () => {
    els.tabs.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const target = btn.dataset.tab;
    els.panels.forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${target}`).classList.add('active');
    if (target === 'favourites') renderParkedCar();
  });
});

function switchToDirectionsTab() {
  document.querySelector('.tab-btn[data-tab="directions"]').click();
}

// ---------- Search panel ----------

const runSearch = debounce(async (query) => {
  const results = await geocode(query);
  renderResultList(els.searchResults, results, (r) => selectSearchResult(r));
}, 350);

els.searchInput.addEventListener('input', (e) => {
  const val = e.target.value;
  els.searchClear.classList.toggle('visible', val.length > 0);
  if (val.length < 2) {
    els.searchResults.innerHTML = '';
    return;
  }
  runSearch(val);
});

els.searchClear.addEventListener('click', () => {
  els.searchInput.value = '';
  els.searchClear.classList.remove('visible');
  els.searchResults.innerHTML = '';
  els.placeCard.classList.add('hidden');
});

function renderResultList(listEl, results, onPick) {
  listEl.innerHTML = '';
  results.forEach(r => {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'r-title';
    title.textContent = shortLabel(r);
    const sub = document.createElement('span');
    sub.className = 'r-sub';
    sub.textContent = addressText(r);
    li.appendChild(title);
    li.appendChild(sub);
    li.addEventListener('click', () => onPick(r));
    listEl.appendChild(li);
  });
}

function selectSearchResult(r) {
  currentPlace = r;
  els.searchResults.innerHTML = '';
  els.searchInput.value = shortLabel(r);

  els.placeName.textContent = shortLabel(r);
  els.placeAddress.textContent = addressText(r);
  els.placeCard.classList.remove('hidden');
}

// ---------- Category quick search (Waze-style "Categories" row) ----------
// Tap 🏥/🍽️/👮 on the Search tab to find the nearest of that kind from your
// current GPS position — reuses the exact same result list + place card +
// "Directions to here" flow as a normal text search, since the results come
// back in the same { label, address, lat, lon } shape.

const CATEGORY_LABELS = {
  hospital: 'hospital',
  food: 'restaurant',
  police: 'police station',
  coffee: 'coffee spot',
  groceries: 'grocery store',
  pharmacy: 'pharmacy',
  shopping: 'mall',
  hotel: 'hotel',
  park: 'park',
  vets: 'vet',
  toilets: 'toilet',
  vegetarian: 'vegetarian-friendly restaurant',
  halal: 'halal restaurant',
  mosque: 'mosque',
  moneychanger: 'money changer',
  postoffice: 'post office',
  library: 'library',
  laundromat: 'laundromat',
  church: 'church',
  temple: 'temple',
  dogpark: 'dog park',
  carpark: 'carpark',
};

// Same OSM tag mapping as the server used to run — moved client-side after
// Railway's own server-to-server calls to Overpass came back "fetch failed"
// (a network-level failure to even connect, not a bad query or slow
// response). Calling Overpass directly from the browser instead sidesteps
// whatever that was, and matches how OSRM routing already works in this app
// — fetched straight from the phone, not proxied through our server.
const CATEGORY_OSM_TAGS = {
  hospital: { key: 'amenity', tags: ['hospital'] },
  police: { key: 'amenity', tags: ['police'] },
  food: { key: 'amenity', tags: ['restaurant', 'fast_food', 'food_court'] },
  coffee: { key: 'amenity', tags: ['cafe'] },
  groceries: { key: 'shop', tags: ['supermarket', 'convenience'] },
  pharmacy: { key: 'amenity', tags: ['pharmacy'] },
  shopping: { key: 'shop', tags: ['mall', 'department_store'] },
  hotel: { key: 'tourism', tags: ['hotel'] },
  park: { key: 'leisure', tags: ['park'] },
  vets: { key: 'amenity', tags: ['veterinary'] },
  toilets: { key: 'amenity', tags: ['toilets'] },
  // Vegetarian/halal aren't their own OSM place types — they're food places
  // (restaurant/cafe/fast_food) additionally tagged diet:vegetarian or
  // diet:halal. In OSM's diet:* scheme, "yes" only means "accommodates this
  // diet" (e.g. a McDonald's with a veggie burger, a Western grill with one
  // halal option) — it does NOT mean the place is actually a vegetarian/halal
  // restaurant. Only "only" means every item served meets the diet, so that's
  // what these chips need to avoid surfacing places that are mostly not
  // vegetarian/halal at all.
  vegetarian: { key: 'amenity', tags: ['restaurant', 'cafe', 'fast_food'], extraKey: 'diet:vegetarian', extraValue: 'only' },
  halal: { key: 'amenity', tags: ['restaurant', 'cafe', 'fast_food'], extraKey: 'diet:halal', extraValue: 'only' },
  // Mosques are place_of_worship + religion=muslim.
  mosque: { key: 'amenity', tags: ['place_of_worship'], extraKey: 'religion', extraValue: 'muslim' },
  // Church/Temple are the same place_of_worship base, split by religion —
  // "Temple" covers Singapore's Buddhist, Taoist, and Hindu temples together.
  church: { key: 'amenity', tags: ['place_of_worship'], extraKey: 'religion', extraValue: 'christian' },
  temple: { key: 'amenity', tags: ['place_of_worship'], extraKey: 'religion', extraValue: 'buddhist|hindu|taoist' },
  moneychanger: { key: 'shop', tags: ['money_exchange'] },
  postoffice: { key: 'amenity', tags: ['post_office'] },
  library: { key: 'amenity', tags: ['library'] },
  laundromat: { key: 'shop', tags: ['laundry'] },
  dogpark: { key: 'leisure', tags: ['dog_park'] },
};
// Tried in order — start close (keeps dense categories like food/coffee
// genuinely local), then widen automatically for sparse categories that
// legitimately don't have one within 1km. Confirmed against Waze itself: for
// a Punggol starting point, Waze's own nearest "Hospitals" result was 1.9km
// away — a hard 1km cutoff would show "nothing found" even though Waze (and
// this app, once widened) finds real hospitals just past that line.
const CATEGORY_SEARCH_RADII_M = [1000, 3000, 6000];
const OVERPASS_HOSTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

function buildCategoryOverpassQuery({ key, tags, extraKey, extraValue }, lat, lon, radius) {
  const filter = tags.length === 1 ? `["${key}"="${tags[0]}"]` : `["${key}"~"^(${tags.join('|')})$"]`;
  // A second bracket filter chains as AND in Overpass QL, so this narrows
  // e.g. "restaurant" down to "restaurant AND diet:vegetarian is yes/only",
  // or "place_of_worship" down to "place_of_worship AND religion=muslim".
  const extraFilter = extraKey ? `["${extraKey}"~"^(${extraValue})$"]` : '';
  const around = `(around:${radius},${lat},${lon})`;
  return `[out:json][timeout:20];(node${filter}${extraFilter}${around};way${filter}${extraFilter}${around};relation${filter}${extraFilter}${around};);out center tags 40;`;
}

async function fetchFromOverpass(query) {
  let lastErr = null;
  for (const host of OVERPASS_HOSTS) {
    // A plain fetch() has no default timeout — without this, one slow/hung
    // mirror could stall the whole search indefinitely, especially across up
    // to 3 radius tiers × 2 mirrors = 6 sequential attempts in the worst case.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(host, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`${host} responded ${res.status}`);
      const data = await res.json();
      return (data.elements || [])
        .map((el) => {
          const point = el.type === 'node' ? el : el.center;
          const t = el.tags || {};
          const name = t.name || t.brand || null;
          if (!point || !name) return null;
          const address = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
          return { label: name, address, lat: point.lat, lon: point.lon };
        })
        .filter(Boolean);
    } catch (err) {
      console.error(`category search via ${host} failed:`, err);
      lastErr = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr || new Error('All Overpass mirrors failed.');
}

async function fetchCategoryPlaces(category, lat, lon, onTierStart) {
  const tagInfo = CATEGORY_OSM_TAGS[category];
  let lastErr = null;
  for (const radius of CATEGORY_SEARCH_RADII_M) {
    if (onTierStart) onTierStart(radius);
    const query = buildCategoryOverpassQuery(tagInfo, lat, lon, radius);
    try {
      const places = await fetchFromOverpass(query);
      if (places.length) return { places, radiusUsed: radius };
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return { places: [], radiusUsed: CATEGORY_SEARCH_RADII_M[CATEGORY_SEARCH_RADII_M.length - 1] };
}

// Carpark uses the same live LTA DataMall feed as the "near destination"
// panel on the Directions tab (see fetchParkingInfo) instead of OpenStreetMap
// — real available-lot counts refreshed roughly every minute, not just a
// pin. Shaped to match fetchCategoryPlaces' { places, radiusUsed } return so
// it can drop straight into the same rendering pipeline below.
async function fetchNearbyCarparks(lat, lon) {
  const res = await fetch(`/api/carparks-nearby?lat=${lat}&lon=${lon}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Carpark availability responded ${res.status}`);
  const places = (data.carparks || []).map((c) => ({
    label: c.development || 'Carpark',
    address: `${c.availableLots} lot${c.availableLots === 1 ? '' : 's'} available`,
    lat: c.lat,
    lon: c.lon,
  }));
  return { places, radiusUsed: null };
}

function searchNearbyCategory(category) {
  if (!navigator.geolocation) {
    showToast('Geolocation is not supported by your browser.');
    return;
  }
  els.placeCard.classList.add('hidden');
  els.searchResults.innerHTML = '<li class="r-loading">Finding your location…</li>';
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      els.searchResults.innerHTML = `<li class="r-loading">Searching nearby ${CATEGORY_LABELS[category]}…</li>`;
      try {
        const { latitude: lat, longitude: lon } = pos.coords;
        const { places, radiusUsed } = category === 'carpark'
          ? await fetchNearbyCarparks(lat, lon)
          : await fetchCategoryPlaces(category, lat, lon, (radius) => {
              els.searchResults.innerHTML = `<li class="r-loading">Searching within ${formatDistance(radius)}…</li>`;
            });
        if (!places.length) {
          els.searchResults.innerHTML = '';
          showToast(radiusUsed
            ? `No ${CATEGORY_LABELS[category]} found within ${formatDistance(radiusUsed)}.`
            : `No ${CATEGORY_LABELS[category]} found nearby.`, 5000);
          return;
        }
        const mapped = places
          .map((p) => ({ ...p, distanceMeters: Math.round(haversineMeters(lat, lon, p.lat, p.lon)) }))
          .sort((a, b) => a.distanceMeters - b.distanceMeters)
          .slice(0, 8)
          .map((r) => ({
            label: r.label,
            address: r.address ? `${r.address} · ${formatDistance(r.distanceMeters)}` : formatDistance(r.distanceMeters),
            lat: r.lat,
            lon: r.lon,
          }));
        renderResultList(els.searchResults, mapped, (r) => selectSearchResult(r));
      } catch (err) {
        console.error('category search failed:', err);
        els.searchResults.innerHTML = '';
        showToast(category === 'carpark' && err.message
          ? err.message
          : 'Could not search nearby places right now — OpenStreetMap\'s search may be unreachable.', 5000);
      }
    },
    (err) => {
      els.searchResults.innerHTML = '';
      showToast(geoErrorMessage(err), 6000);
    },
    GEO_OPTIONS
  );
}

// A handful of chips are a single fixed landmark rather than "find the
// nearest X near me" — tapping one jumps straight to that place (no GPS
// fix needed first) using the same place-card + "Directions to here" flow
// as picking a normal search result.
const LANDMARKS = {
  mbs: { label: 'Marina Bay Sands', address: '10 Bayfront Ave, Singapore 018956', lat: 1.283927, lon: 103.860535 },
  gardensbythebay: { label: 'Gardens by the Bay', address: '18 Marina Gardens Dr, Singapore 018953', lat: 1.28160, lon: 103.86360 },
  sentosa: { label: 'Sentosa Island', address: 'Sentosa Gateway, Singapore', lat: 1.24940, lon: 103.83030 },
  uss: { label: 'Universal Studios Singapore', address: '8 Sentosa Gateway, Singapore 098269', lat: 1.25400, lon: 103.82380 },
  seaaquarium: { label: 'S.E.A. Aquarium', address: '8 Sentosa Gateway, Singapore 098269', lat: 1.25780, lon: 103.82030 },
  jewelchangi: { label: 'Jewel Changi Airport', address: '78 Airport Blvd, Singapore 819666', lat: 1.36030, lon: 103.98950 },
  merlionpark: { label: 'Merlion Park', address: '1 Fullerton Rd, Singapore 049213', lat: 1.28680, lon: 103.85450 },
  sgflyer: { label: 'Singapore Flyer', address: '30 Raffles Ave, Singapore 039803', lat: 1.28930, lon: 103.86320 },
  sgzoo: { label: 'Singapore Zoo', address: '80 Mandai Lake Rd, Singapore 729826', lat: 1.40430, lon: 103.79300 },
  nightsafari: { label: 'Night Safari', address: '80 Mandai Lake Rd, Singapore 729826', lat: 1.40226, lon: 103.78789 },
  riverwonders: { label: 'River Wonders', address: '80 Mandai Lake Rd, Singapore 729826', lat: 1.40378, lon: 103.79414 },
  chinatown: { label: 'Chinatown', address: 'Chinatown, Singapore', lat: 1.28120, lon: 103.84430 },
  littleindia: { label: 'Little India', address: 'Little India, Singapore', lat: 1.30670, lon: 103.85180 },
  kampongglam: { label: 'Kampong Glam', address: 'Kampong Glam, Singapore', lat: 1.30210, lon: 103.85900 },
  clarkequay: { label: 'Clarke Quay', address: '3 River Valley Rd, Singapore 179024', lat: 1.28840, lon: 103.84650 },
  botanicgardens: { label: 'Singapore Botanic Gardens', address: '1 Cluny Rd, Singapore 259569', lat: 1.31380, lon: 103.81590 },
  nationalgallery: { label: 'National Gallery Singapore', address: "1 St Andrew's Rd, Singapore 178957", lat: 1.29030, lon: 103.85170 },
  artsciencemuseum: { label: 'ArtScience Museum', address: '6 Bayfront Ave, Singapore 018974', lat: 1.28620, lon: 103.85930 },
  esplanade: { label: 'Esplanade', address: '1 Esplanade Dr, Singapore 038981', lat: 1.28970, lon: 103.85580 },
  hawparvilla: { label: 'Haw Par Villa', address: '262 Pasir Panjang Rd, Singapore 118628', lat: 1.28220, lon: 103.78150 },
  eastcoastpark: { label: 'East Coast Park', address: 'East Coast Park, Singapore', lat: 1.30160, lon: 103.91240 },
  // The Causeway crossing into Johor Bahru — routes here the same as any
  // other landmark, then the app's own turn-by-turn takes over right up to
  // the checkpoint gantries (actual immigration/customs clearance is of
  // course outside anything a maps app can do).
  woodlandscheckpoint: { label: 'Woodlands Checkpoint (JB Causeway)', address: 'Woodlands Checkpoint, Singapore 738099', lat: 1.44780, lon: 103.76910 },
  // The Second Link crossing into Johor — better for Legoland/Puteri
  // Harbour or avoiding Causeway jams.
  tuascheckpoint: { label: 'Tuas Checkpoint (2nd Link)', address: '1 Jalan Tukang, Singapore 638357', lat: 1.34740, lon: 103.63670 },
  // ICA's main HQ building (Kallang) — passport/IC renewal, PR/EP/S Pass
  // applications, etc. Distinct from the two border checkpoints above.
  icabuilding: { label: 'ICA Building', address: '10 Kallang Rd, Singapore 208718', lat: 1.30570, lon: 103.86310 },
  // MOM Services Centre (Bendemeer) — work pass applications/renewals,
  // employment disputes/claims, foreign worker matters, etc.
  momservices: { label: 'MOM Services Centre', address: '1500 Bendemeer Rd, Singapore 339946', lat: 1.326422, lon: 103.869041 },
};

document.querySelectorAll('.category-chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    const category = btn.dataset.category;
    if (LANDMARKS[category]) {
      selectSearchResult(LANDMARKS[category]);
    } else {
      searchNearbyCategory(category);
    }
  });
});

// ---------- Language (UI chrome only) ----------
// Covers the app's own buttons/labels/menus and all category+landmark chip
// names — Singapore's four official languages. Search results themselves
// (restaurant names, street addresses from OneMap/OSM/LTA, turn-by-turn
// voice instructions, live weather/traffic text) come from those upstream
// sources as-is and aren't translated here.
const LANG_STORAGE_KEY = 'wp_lang';
const LANG_CYCLE = ['en', 'zh', 'ms', 'ta'];
const LANG_SHORT = { en: 'EN', zh: '中文', ms: 'BM', ta: 'TA' };
const LANG_HTML_TAG = { en: 'en', zh: 'zh-Hans', ms: 'ms', ta: 'ta' };

let currentLang = 'en';
try {
  const saved = localStorage.getItem(LANG_STORAGE_KEY);
  if (saved && LANG_CYCLE.includes(saved)) currentLang = saved;
} catch (err) { /* private-mode/blocked storage — default to English */ }

const I18N = {
  en: {
    tab_search: 'Search', tab_directions: 'Directions', tab_bus: '🚌 Bus Arrival Time',
    notify_title: 'Turn on train/traffic alerts', where_am_i: 'Where am I',
    offline_banner: "You're offline — showing saved places & last-known data. Search, routing and live arrivals need a connection.",
    search_placeholder: 'Enter postal code, address, or place…', clear: 'Clear',
    category_nearby: 'Nearby', category_attractions: 'Attractions',
    directions_from_here: 'Directions from here', directions_to_here: 'Directions to here',
    set_home: '🏠 Set as Home', set_work: '💼 Set as Work',
    hint_search: 'Try searching for a landmark, street, or postal code.',
    quick_home: '🏠 Home', quick_work: '💼 Work',
    dir_from_placeholder: 'From — postal code, address, or place', dir_to_placeholder: 'To — postal code, address, or place',
    swap: 'Swap', mode_drive: 'Drive', mode_transit: 'Bus / MRT', mode_cycle: 'Cycle', mode_walk: 'Walk',
    get_directions: 'Get Directions', start_navigation: '▶️ Start Navigation',
    car_parked: 'Car parked', tap_to_walk_back: 'Tap below to walk back to it', walk_to_car: 'Walk to my car',
    save_parking: '🅿️ Save my parking spot', nearby_stops: '📍 Stops near me',
    fav_search_placeholder: 'Add a bus stop — code or name…',
    fav_empty_hint: 'Search for a bus stop above and add it to check live arrivals here anytime — no need to plan a trip first.',
    share_footer: '💙 Share this app if you find it useful', support_footer: '☕ Buy me a coffee — help keep Waypoint running',
    install_banner_text: '📲 Add Waypoint to your home screen for quick access', install: 'Install', not_now: 'Not now',
    dismiss: 'Dismiss',
  },
  zh: {
    tab_search: '搜索', tab_directions: '路线', tab_bus: '🚌 巴士到站时间',
    notify_title: '开启地铁/交通提醒', where_am_i: '我的位置',
    offline_banner: '您已离线 — 显示已保存的地点和最新数据。搜索、路线规划和实时到站信息需要网络连接。',
    search_placeholder: '输入邮区编号、地址或地点…', clear: '清除',
    category_nearby: '附近', category_attractions: '景点',
    directions_from_here: '从这里出发', directions_to_here: '前往这里',
    set_home: '🏠 设为住家', set_work: '💼 设为公司',
    hint_search: '试试搜索地标、街道或邮区编号。',
    quick_home: '🏠 住家', quick_work: '💼 公司',
    dir_from_placeholder: '起点 — 邮区编号、地址或地点', dir_to_placeholder: '终点 — 邮区编号、地址或地点',
    swap: '互换', mode_drive: '驾车', mode_transit: '巴士 / 地铁', mode_cycle: '骑行', mode_walk: '步行',
    get_directions: '获取路线', start_navigation: '▶️ 开始导航',
    car_parked: '停车时间', tap_to_walk_back: '点击下方步行返回车辆位置', walk_to_car: '步行回到我的车',
    save_parking: '🅿️ 保存停车位置', nearby_stops: '📍 附近车站',
    fav_search_placeholder: '添加巴士车站 — 输入编号或名称…',
    fav_empty_hint: '在上方搜索巴士车站并添加，即可随时查看实时到站时间 — 无需先规划行程。',
    share_footer: '💙 如果觉得好用，欢迎分享给朋友', support_footer: '☕ 请我喝杯咖啡 — 支持 Waypoint 持续运作',
    install_banner_text: '📲 将 Waypoint 添加到主屏幕，方便快速使用', install: '安装', not_now: '暂不安装',
    dismiss: '关闭',
  },
  ms: {
    tab_search: 'Carian', tab_directions: 'Arah', tab_bus: '🚌 Waktu Ketibaan Bas',
    notify_title: 'Hidupkan makluman keretapi/trafik', where_am_i: 'Di Mana Saya',
    offline_banner: 'Anda di luar talian — memaparkan tempat tersimpan & data terkini. Carian, laluan dan ketibaan langsung memerlukan sambungan internet.',
    search_placeholder: 'Masukkan poskod, alamat, atau tempat…', clear: 'Kosongkan',
    category_nearby: 'Berdekatan', category_attractions: 'Tempat Menarik',
    directions_from_here: 'Arah dari sini', directions_to_here: 'Arah ke sini',
    set_home: '🏠 Tetapkan sebagai Rumah', set_work: '💼 Tetapkan sebagai Tempat Kerja',
    hint_search: 'Cuba cari mercu tanda, jalan, atau poskod.',
    quick_home: '🏠 Rumah', quick_work: '💼 Tempat Kerja',
    dir_from_placeholder: 'Dari — poskod, alamat, atau tempat', dir_to_placeholder: 'Ke — poskod, alamat, atau tempat',
    swap: 'Tukar', mode_drive: 'Memandu', mode_transit: 'Bas / MRT', mode_cycle: 'Berbasikal', mode_walk: 'Berjalan kaki',
    get_directions: 'Dapatkan Arah', start_navigation: '▶️ Mula Navigasi',
    car_parked: 'Kereta diletak', tap_to_walk_back: 'Ketik di bawah untuk berjalan kembali ke sana', walk_to_car: 'Berjalan ke kereta saya',
    save_parking: '🅿️ Simpan lokasi tempat letak kereta saya', nearby_stops: '📍 Perhentian berdekatan',
    fav_search_placeholder: 'Tambah perhentian bas — kod atau nama…',
    fav_empty_hint: 'Cari perhentian bas di atas dan tambahkannya untuk semak ketibaan langsung di sini bila-bila masa — tidak perlu rancang perjalanan dahulu.',
    share_footer: '💙 Kongsikan aplikasi ini jika berguna', support_footer: '☕ Belanja saya kopi — bantu kekalkan Waypoint berjalan',
    install_banner_text: '📲 Tambah Waypoint ke skrin utama untuk akses pantas', install: 'Pasang', not_now: 'Bukan sekarang',
    dismiss: 'Tutup',
  },
  ta: {
    tab_search: 'தேடல்', tab_directions: 'வழிகள்', tab_bus: '🚌 பேருந்து வருகை நேரம்',
    notify_title: 'ரயில்/போக்குவரத்து எச்சரிக்கைகளை இயக்கு', where_am_i: 'நான் எங்கே',
    offline_banner: 'நீங்கள் ஆஃப்லைனில் உள்ளீர்கள் — சேமிக்கப்பட்ட இடங்கள் மற்றும் சமீபத்திய தரவு காட்டப்படுகிறது. தேடல், வழிகள் மற்றும் நேரலை வருகைக்கு இணைப்பு தேவை.',
    search_placeholder: 'அஞ்சல் குறியீடு, முகவரி அல்லது இடத்தை உள்ளிடவும்…', clear: 'அழி',
    category_nearby: 'அருகில்', category_attractions: 'சுற்றுலா தளங்கள்',
    directions_from_here: 'இங்கிருந்து வழிகள்', directions_to_here: 'இங்கு வழிகள்',
    set_home: '🏠 வீடாக அமை', set_work: '💼 பணியிடமாக அமை',
    hint_search: 'ஒரு அடையாளம், தெரு அல்லது அஞ்சல் குறியீட்டைத் தேடிப் பாருங்கள்.',
    quick_home: '🏠 வீடு', quick_work: '💼 பணியிடம்',
    dir_from_placeholder: 'இருந்து — அஞ்சல் குறியீடு, முகவரி அல்லது இடம்', dir_to_placeholder: 'வரை — அஞ்சல் குறியீடு, முகவரி அல்லது இடம்',
    swap: 'மாற்று', mode_drive: 'ஓட்டுதல்', mode_transit: 'பேருந்து / எம்ஆர்டி', mode_cycle: 'சைக்கிள்', mode_walk: 'நடை',
    get_directions: 'வழிகளைப் பெறுக', start_navigation: '▶️ வழிகாட்டலைத் தொடங்கு',
    car_parked: 'கார் நிறுத்தப்பட்டது', tap_to_walk_back: 'அங்கு நடந்து செல்ல கீழே தட்டவும்', walk_to_car: 'எனது காருக்கு நடந்து செல்',
    save_parking: '🅿️ எனது பார்க்கிங் இடத்தைச் சேமி', nearby_stops: '📍 அருகிலுள்ள நிறுத்தங்கள்',
    fav_search_placeholder: 'பேருந்து நிறுத்தத்தைச் சேர் — குறியீடு அல்லது பெயர்…',
    fav_empty_hint: 'மேலே ஒரு பேருந்து நிறுத்தத்தைத் தேடி சேர்த்து, எப்போது வேண்டுமானாலும் நேரலை வருகையைச் சரிபார்க்கலாம் — முதலில் பயணத்தைத் திட்டமிட வேண்டியதில்லை.',
    share_footer: '💙 இது பயனுள்ளதாக இருந்தால் இந்த ஆப்பைப் பகிரவும்', support_footer: '☕ எனக்கு ஒரு காபி வாங்கிக் கொடுங்கள் — Waypoint செயல்பட உதவுங்கள்',
    install_banner_text: '📲 விரைவு அணுகலுக்காக Waypoint-ஐ உங்கள் முகப்புத் திரையில் சேர்க்கவும்', install: 'நிறுவு', not_now: 'இப்போது வேண்டாம்',
    dismiss: 'மூடு',
  },
};

// Chip label translations, keyed by data-category. English values here match
// what's already hardcoded in index.html (used as the fallback / source of
// truth when a key is somehow missing from a language).
const CHIP_I18N = {
  food: { en: 'Food', zh: '美食', ms: 'Makanan', ta: 'உணவு' },
  carpark: { en: 'Carpark', zh: '停车场', ms: 'Tempat Letak Kereta', ta: 'கார் பார்க்கிங்' },
  coffee: { en: 'Coffee', zh: '咖啡', ms: 'Kopi', ta: 'காபி' },
  groceries: { en: 'Groceries', zh: '杂货店', ms: 'Barangan Runcit', ta: 'மளிகை' },
  shopping: { en: 'Shopping', zh: '购物中心', ms: 'Membeli-belah', ta: 'ஷாப்பிங்' },
  pharmacy: { en: 'Pharmacy', zh: '药店', ms: 'Farmasi', ta: 'மருந்தகம்' },
  hospital: { en: 'Hospital', zh: '医院', ms: 'Hospital', ta: 'மருத்துவமனை' },
  police: { en: 'Police', zh: '警察局', ms: 'Balai Polis', ta: 'காவல் நிலையம்' },
  hotel: { en: 'Hotel', zh: '酒店', ms: 'Hotel', ta: 'ஹோட்டல்' },
  park: { en: 'Park', zh: '公园', ms: 'Taman', ta: 'பூங்கா' },
  vets: { en: 'Vets', zh: '兽医', ms: 'Doktor Haiwan', ta: 'கால்நடை மருத்துவர்' },
  toilets: { en: 'Toilets', zh: '洗手间', ms: 'Tandas', ta: 'கழிப்பறை' },
  vegetarian: { en: 'Vegetarian', zh: '素食', ms: 'Vegetarian', ta: 'சைவம்' },
  halal: { en: 'Halal', zh: '清真', ms: 'Halal', ta: 'ஹலால்' },
  mosque: { en: 'Mosque', zh: '清真寺', ms: 'Masjid', ta: 'மசூதி' },
  church: { en: 'Church', zh: '教堂', ms: 'Gereja', ta: 'தேவாலயம்' },
  temple: { en: 'Temple', zh: '庙宇', ms: 'Kuil', ta: 'கோவில்' },
  moneychanger: { en: 'Money Changer', zh: '找换店', ms: 'Penukar Wang', ta: 'பண மாற்று நிலையம்' },
  postoffice: { en: 'Post Office', zh: '邮局', ms: 'Pejabat Pos', ta: 'அஞ்சல் அலுவலகம்' },
  library: { en: 'Library', zh: '图书馆', ms: 'Perpustakaan', ta: 'நூலகம்' },
  laundromat: { en: 'Laundromat', zh: '自助洗衣店', ms: 'Dobi Layan Diri', ta: 'சலவை நிலையம்' },
  dogpark: { en: 'Dog Park', zh: '狗狗公园', ms: 'Taman Anjing', ta: 'நாய் பூங்கா' },
  mbs: { en: 'Marina Bay Sands', zh: '滨海湾金沙', ms: 'Marina Bay Sands', ta: 'மரீனா பே சாண்ட்ஸ்' },
  gardensbythebay: { en: 'Gardens by the Bay', zh: '滨海湾花园', ms: 'Gardens by the Bay', ta: 'கார்டன்ஸ் பை தி பே' },
  sentosa: { en: 'Sentosa Island', zh: '圣淘沙岛', ms: 'Pulau Sentosa', ta: 'செண்டோசா தீவு' },
  uss: { en: 'Universal Studios', zh: '环球影城', ms: 'Universal Studios', ta: 'யுனிவர்சல் ஸ்டுடியோஸ்' },
  seaaquarium: { en: 'S.E.A. Aquarium', zh: '星耀水族馆', ms: 'Akuarium S.E.A.', ta: 'எஸ்.இ.ஏ. மீன்காட்சியகம்' },
  jewelchangi: { en: 'Jewel Changi', zh: '星耀樟宜', ms: 'Jewel Changi', ta: 'ஜூவல் சாங்கி' },
  merlionpark: { en: 'Merlion Park', zh: '鱼尾狮公园', ms: 'Taman Merlion', ta: 'மெர்லயன் பூங்கா' },
  sgflyer: { en: 'Singapore Flyer', zh: '新加坡摩天观景轮', ms: 'Singapore Flyer', ta: 'சிங்கப்பூர் ஃபிளையர்' },
  sgzoo: { en: 'Singapore Zoo', zh: '新加坡动物园', ms: 'Zoo Singapura', ta: 'சிங்கப்பூர் உயிரியல் பூங்கா' },
  nightsafari: { en: 'Night Safari', zh: '夜间野生动物园', ms: 'Night Safari', ta: 'நைட் சஃபாரி' },
  riverwonders: { en: 'River Wonders', zh: '河川生态园', ms: 'River Wonders', ta: 'ரிவர் வண்டர்ஸ்' },
  chinatown: { en: 'Chinatown', zh: '牛车水', ms: 'Chinatown', ta: 'சைனாடவுன்' },
  littleindia: { en: 'Little India', zh: '小印度', ms: 'Little India', ta: 'லிட்டில் இந்தியா' },
  kampongglam: { en: 'Kampong Glam', zh: '甘榜格南', ms: 'Kampung Glam', ta: 'கம்போங் கிளாம்' },
  clarkequay: { en: 'Clarke Quay', zh: '克拉码头', ms: 'Clarke Quay', ta: 'கிளார்க் கீ' },
  botanicgardens: { en: 'Botanic Gardens', zh: '植物园', ms: 'Kebun Botani', ta: 'தாவரவியல் பூங்கா' },
  nationalgallery: { en: 'National Gallery', zh: '国家美术馆', ms: 'Galeri Negara', ta: 'தேசிய கேலரி' },
  artsciencemuseum: { en: 'ArtScience Museum', zh: '艺术科学博物馆', ms: 'Muzium ArtScience', ta: 'ஆர்ட்சயின்ஸ் அருங்காட்சியகம்' },
  esplanade: { en: 'Esplanade', zh: '滨海艺术中心', ms: 'Esplanade', ta: 'எஸ்பிளனேட்' },
  hawparvilla: { en: 'Haw Par Villa', zh: '虎豹别墅', ms: 'Haw Par Villa', ta: 'ஹா பார் வில்லா' },
  eastcoastpark: { en: 'East Coast Park', zh: '东海岸公园', ms: 'Taman Pantai Timur', ta: 'கிழக்குக் கடற்கரைப் பூங்கா' },
  woodlandscheckpoint: { en: 'To JB (Causeway)', zh: '前往新山（长堤）', ms: 'Ke JB (Tambak)', ta: 'ஜேபிக்கு (காஸ்வே)' },
  tuascheckpoint: { en: 'To JB (2nd Link)', zh: '前往新山（第二通道）', ms: 'Ke JB (Laluan Kedua)', ta: 'ஜேபிக்கு (2வது இணைப்பு)' },
  icabuilding: { en: 'ICA Building', zh: '移民与关卡局大厦', ms: 'Bangunan ICA', ta: 'ஐசிஏ கட்டிடம்' },
  momservices: { en: 'MOM Services', zh: '人力部服务中心', ms: 'Perkhidmatan KSM', ta: 'MOM சேவைகள்' },
};

function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.getAttribute('data-i18n-title')); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  document.querySelectorAll('.category-chip').forEach((btn) => {
    const cat = btn.dataset.category;
    const entry = CHIP_I18N[cat];
    const label = entry && (entry[currentLang] || entry.en);
    if (!label) return;
    const iconEl = btn.querySelector('.category-chip-icon');
    btn.textContent = '';
    if (iconEl) btn.appendChild(iconEl);
    btn.appendChild(document.createTextNode(label));
  });
  if (els.langBtn) els.langBtn.textContent = `🌐 ${LANG_SHORT[currentLang]}`;
  document.documentElement.lang = LANG_HTML_TAG[currentLang] || 'en';
}

if (els.langBtn) {
  els.langBtn.addEventListener('click', () => {
    const idx = LANG_CYCLE.indexOf(currentLang);
    currentLang = LANG_CYCLE[(idx + 1) % LANG_CYCLE.length];
    try { localStorage.setItem(LANG_STORAGE_KEY, currentLang); } catch (err) { /* ignore */ }
    applyTranslations();
  });
}

applyTranslations();

els.dirFromHere.addEventListener('click', () => {
  if (!currentPlace) return;
  setFrom({ lat: parseFloat(currentPlace.lat), lon: parseFloat(currentPlace.lon), label: shortLabel(currentPlace) });
  switchToDirectionsTab();
});

els.dirToHere.addEventListener('click', () => {
  if (!currentPlace) return;
  setTo({ lat: parseFloat(currentPlace.lat), lon: parseFloat(currentPlace.lon), label: shortLabel(currentPlace) });
  switchToDirectionsTab();
});

// ---------- Home / Work quick locations ----------
// Saved once from a search result ("Set as Home"/"Set as Work"), then usable
// as a one-tap fill from the Directions panel — Home fills the "From" field
// (the common case of starting a trip from home) and Work fills "To" (the
// common case of heading to work), so tapping both in sequence gives a
// ready-to-go "Home → Work" route without retyping either address.

const HOME_KEY = 'waypoint_home';
const WORK_KEY = 'waypoint_work';

function loadQuickLocation(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    return raw && typeof raw.lat === 'number' && typeof raw.lon === 'number' ? raw : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

function saveQuickLocation(key, coords) {
  try {
    localStorage.setItem(key, JSON.stringify(coords));
  } catch (err) {
    console.error(err);
  }
}

function currentPlaceCoords() {
  if (!currentPlace) return null;
  const lat = typeof currentPlace.lat === 'string' ? parseFloat(currentPlace.lat) : currentPlace.lat;
  const lon = typeof currentPlace.lon === 'string' ? parseFloat(currentPlace.lon) : currentPlace.lon;
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { lat, lon, label: shortLabel(currentPlace) };
}

function updateQuickButtons() {
  const home = loadQuickLocation(HOME_KEY);
  const work = loadQuickLocation(WORK_KEY);
  els.quickHomeBtn.classList.toggle('unset', !home);
  els.quickHomeBtn.title = home ? `Start from ${home.label}` : 'Not set yet — search a place, then "Set as Home"';
  els.quickWorkBtn.classList.toggle('unset', !work);
  els.quickWorkBtn.title = work ? `Directions to ${work.label}` : 'Not set yet — search a place, then "Set as Work"';
}

els.setHomeBtn.addEventListener('click', () => {
  const coords = currentPlaceCoords();
  if (!coords) return;
  saveQuickLocation(HOME_KEY, coords);
  updateQuickButtons();
  showToast('🏠 Home set!');
});

els.setWorkBtn.addEventListener('click', () => {
  const coords = currentPlaceCoords();
  if (!coords) return;
  saveQuickLocation(WORK_KEY, coords);
  updateQuickButtons();
  showToast('💼 Work set!');
});

function useQuickLocation(key, label, setter) {
  const loc = loadQuickLocation(key);
  if (!loc) {
    showToast(`Set your ${label} first — search a place, then tap "Set as ${label}".`);
    document.querySelector('.tab-btn[data-tab="search"]').click();
    return;
  }
  setter(loc);
  switchToDirectionsTab();
}

// Home fills "From" (you're usually starting a trip from home); Work fills
// "To" (you're usually heading to work) — tap both for a ready "Home → Work".
els.quickHomeBtn.addEventListener('click', () => useQuickLocation(HOME_KEY, 'Home', setFrom));
els.quickWorkBtn.addEventListener('click', () => useQuickLocation(WORK_KEY, 'Work', setTo));

// ---------- "My Parked Car" — remember where you left it ----------
// Saved locally only (never sent anywhere). Auto-saved the moment live
// driving navigation reaches your destination; can also be saved manually
// from the Favourites tab for trips driven without in-app navigation.

const PARKED_CAR_KEY = 'waypoint_parked_car';

function loadParkedCar() {
  try {
    const raw = JSON.parse(localStorage.getItem(PARKED_CAR_KEY) || 'null');
    return raw && typeof raw.lat === 'number' && typeof raw.lon === 'number' ? raw : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

function saveParkedCar(lat, lon) {
  try {
    localStorage.setItem(PARKED_CAR_KEY, JSON.stringify({ lat, lon, savedAt: Date.now() }));
  } catch (err) {
    console.error(err);
  }
  renderParkedCar();
}

function clearParkedCar() {
  try {
    localStorage.removeItem(PARKED_CAR_KEY);
  } catch (err) {
    console.error(err);
  }
  renderParkedCar();
}

function formatAgoLong(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} day(s) ago`;
}

function renderParkedCar() {
  const car = loadParkedCar();
  els.parkedCarCard.classList.toggle('hidden', !car);
  if (car) els.parkedCarAgo.textContent = formatAgoLong(car.savedAt);
}

function saveParkingSpotFromGeolocation(silent) {
  if (!navigator.geolocation) {
    if (!silent) showToast('Geolocation is not supported by your browser.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      saveParkedCar(pos.coords.latitude, pos.coords.longitude);
      if (!silent) showToast('🅿️ Parking spot saved.');
    },
    (err) => {
      if (!silent) showToast(geoErrorMessage(err) + ' (needed to save your parking spot)');
    },
    GEO_OPTIONS
  );
}

els.saveParkingBtn.addEventListener('click', () => saveParkingSpotFromGeolocation(false));

els.parkedCarClearBtn.addEventListener('click', () => {
  clearParkedCar();
  showToast('Parking spot cleared.');
});

els.parkedCarDirectionsBtn.addEventListener('click', () => {
  const car = loadParkedCar();
  if (!car) return;
  if (!navigator.geolocation) {
    showToast('Geolocation is not supported by your browser.');
    return;
  }
  showToast('Locating you…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // GPS works fine offline, but the walking route itself comes from OSRM,
      // which needs a connection. Don't pre-check navigator.onLine here — it's
      // unreliable and can falsely report offline on a working connection.
      // getDirections() below already handles a genuine offline/failed fetch
      // reactively (straight-line distance + compass heading fallback), so
      // just always proceed and let it decide.
      setFrom({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Your location' });
      setTo({ lat: car.lat, lon: car.lon, label: 'Your parked car' });
      selectedMode = 'walking';
      els.modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === 'walking'));
      switchToDirectionsTab();
      getDirections();
    },
    (err) => showToast(geoErrorMessage(err) + ' (needed to walk back to your car)'),
    GEO_OPTIONS
  );
});

renderParkedCar();

// ---------- Directions panel ----------

function setFrom(coords) {
  fromCoords = coords;
  els.fromInput.value = coords.label;
  maybeEnableDirections();
}

function setTo(coords) {
  toCoords = coords;
  els.toInput.value = coords.label;
  maybeEnableDirections();
}

function maybeEnableDirections() {
  els.getDirectionsBtn.disabled = !(fromCoords && toCoords);
}

// ---------- Rain awareness ----------
// Only relevant when the route includes actual time on foot (walking mode,
// or transit — which always has walk legs to/from stops). Checks the NEA
// 2-hour forecast near both ends of the trip and surfaces a banner if either
// is showing rain/showers.

function hideRainAlert() {
  els.rainBanner.classList.add('hidden');
}

function showRainAlert(text) {
  els.rainBannerText.textContent = text;
  els.rainBanner.classList.remove('hidden');
}

async function checkRainAlert(from, to) {
  hideRainAlert();
  if (!from || !to) return;
  try {
    const [fromWx, toWx] = await Promise.all([
      fetch(`/api/weather-nearby?lat=${from.lat}&lon=${from.lon}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/weather-nearby?lat=${to.lat}&lon=${to.lon}`).then((r) => (r.ok ? r.json() : null)),
    ]);
    const rainy = [fromWx, toWx].filter((w) => w && w.isRainy);
    if (!rainy.length) return;
    const areas = [...new Set(rainy.map((w) => w.area))].join(' & ');
    showRainAlert(`${rainy[0].forecast} near ${areas} — bring an umbrella for the walk!`);
  } catch (err) {
    console.error('rain check failed:', err);
  }
}

const runFromSearch = debounce(async (q) => {
  const results = await geocode(q);
  renderResultList(els.fromResults, results, (r) => {
    setFrom({ lat: parseFloat(r.lat), lon: parseFloat(r.lon), label: shortLabel(r) });
    els.fromResults.innerHTML = '';
  });
}, 350);

const runToSearch = debounce(async (q) => {
  const results = await geocode(q);
  renderResultList(els.toResults, results, (r) => {
    setTo({ lat: parseFloat(r.lat), lon: parseFloat(r.lon), label: shortLabel(r) });
    els.toResults.innerHTML = '';
  });
}, 350);

els.fromInput.addEventListener('input', (e) => {
  fromCoords = null;
  maybeEnableDirections();
  const v = e.target.value;
  if (v.length < 2) { els.fromResults.innerHTML = ''; return; }
  runFromSearch(v);
});

els.toInput.addEventListener('input', (e) => {
  toCoords = null;
  maybeEnableDirections();
  const v = e.target.value;
  if (v.length < 2) { els.toResults.innerHTML = ''; return; }
  runToSearch(v);
});

document.addEventListener('click', (e) => {
  if (!els.fromInput.contains(e.target)) els.fromResults.innerHTML = '';
  if (!els.toInput.contains(e.target)) els.toResults.innerHTML = '';
  // Tapping a category chip (🏥/🍽️/etc) lives outside both the search input
  // and the results list, so without this it would immediately wipe out the
  // "Finding your location…" text the same click was meant to trigger —
  // the search would then run with zero visible feedback until it either
  // finished or the person gave up waiting.
  const clickedCategoryChip = els.categoryRow && els.categoryRow.contains(e.target);
  if (!els.searchInput.contains(e.target) && !els.searchResults.contains(e.target) && !clickedCategoryChip) {
    els.searchResults.innerHTML = '';
  }
});

els.swapBtn.addEventListener('click', () => {
  const tmpCoords = fromCoords, tmpVal = els.fromInput.value;
  if (toCoords) setFrom(toCoords); else { fromCoords = null; els.fromInput.value = els.toInput.value; }
  if (tmpCoords) setTo(tmpCoords); else { toCoords = null; els.toInput.value = tmpVal; }
  maybeEnableDirections();
});

els.modeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    els.modeButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMode = btn.dataset.mode;
    if (selectedMode === 'cycling') {
      showCyclingExtra(); // instant, doesn't need a calculated route
    } else {
      els.cyclingExtra.classList.add('hidden');
      els.cyclingExtra.innerHTML = '';
    }
    if (fromCoords && toCoords && hasRoute) {
      getDirections();
    }
  });
});

els.getDirectionsBtn.addEventListener('click', getDirections);

function hideDrivingExtras() {
  els.parkingInfo.classList.add('hidden');
  els.parkingInfo.innerHTML = '';
  els.evChargingInfo.classList.add('hidden');
  els.evChargingInfo.innerHTML = '';
  els.petrolInfo.classList.add('hidden');
  els.petrolInfo.innerHTML = '';
  els.erpInfo.classList.add('hidden');
  els.erpInfo.innerHTML = '';
  els.trafficInfo.classList.add('hidden');
  els.trafficInfo.innerHTML = '';
  navTrafficOverlays = [];
  els.cyclingExtra.classList.add('hidden');
  els.cyclingExtra.innerHTML = '';
  els.startNavBtn.classList.add('hidden');
  stopNavigation(false);
}

// Anywheel (and every other Singapore dockless bike-share operator) doesn't
// publish a public API or GBFS feed — checked the official GBFS registry,
// LTA DataMall's full dataset list, and community bike-share API docs, none
// have it. So rather than guess at bike locations, this just opens Anywheel's
// own app/site where their live map actually lives.
function anywheelLink() {
  const ua = navigator.userAgent || '';
  if (/android/i.test(ua)) return 'https://play.google.com/store/apps/details?id=com.ytyiot.ebike.anywheel';
  if (/iphone|ipad|ipod/i.test(ua)) return 'https://apps.apple.com/sg/app/anywheel/id1453812982';
  return 'https://www.anywheel.sg/';
}

function showCyclingExtra() {
  els.cyclingExtra.classList.remove('hidden');
  els.cyclingExtra.innerHTML = '<div class="driving-extra-title">🚲 Need a bike?</div>'
    + '<div class="driving-extra-note">Waypoint doesn\'t have live Anywheel bike locations (no public API exists) — check their own live map instead.</div>'
    + `<a href="${anywheelLink()}" target="_blank" rel="noopener" class="pill-btn primary driving-extra-link">Open Anywheel</a>`;
}

// Escapes a string for safe use inside an HTML attribute (e.g. data-label="...").
function escapeAttr(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Re-routes within Waypoint itself (instead of bouncing out to Google Maps)
// when the person taps a parking / EV charging / petrol station row — sets
// that spot as the new destination and re-runs directions.
async function routeToPoint(lat, lon, label) {
  setTo({ lat, lon, label });
  await getDirections();
}

// Driving-extra rows are rendered as <a href="#" data-lat/data-lon/data-label>
// rather than real links, so this wires them up to route within the app.
// Called once right after each panel's innerHTML is set.
function wireDrivingExtraLinks(container) {
  container.querySelectorAll('.driving-extra-link-row').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const lat = parseFloat(el.dataset.lat);
      const lon = parseFloat(el.dataset.lon);
      routeToPoint(lat, lon, el.dataset.label || '');
    });
  });
}

async function loadParkingInfo(coords) {
  els.parkingInfo.classList.remove('hidden');
  els.parkingInfo.innerHTML = '<div class="driving-extra-title">🅿️ Parking near destination</div><div class="driving-extra-row">Loading…</div>';
  try {
    const res = await fetch(`/api/carparks-nearby?lat=${coords.lat}&lon=${coords.lon}`);
    const data = await res.json();
    if (!res.ok || !data.carparks || !data.carparks.length) {
      els.parkingInfo.classList.add('hidden');
      return;
    }
    els.parkingInfo.innerHTML = '<div class="driving-extra-title">🅿️ Parking near destination</div>' + data.carparks.map((c) => {
      const label = escapeAttr(`${c.development} (${c.agency})`);
      return `
        <a class="driving-extra-row driving-extra-link-row" href="#" data-lat="${c.lat}" data-lon="${c.lon}" data-label="${label}">
          <span>${c.development} (${c.agency}) · ${formatDistance(c.distanceMeters)}</span>
          <span class="driving-extra-lots">${Number.isFinite(c.availableLots) ? c.availableLots + ' lots' : '—'}</span>
        </a>
      `;
    }).join('');
    wireDrivingExtraLinks(els.parkingInfo);
  } catch (err) {
    console.error('parking info failed:', err);
    els.parkingInfo.classList.add('hidden');
  }
}

// Summarizes a station's plugTypes map (e.g. {"Type 2": 3, "CCS 2": 5}) into
// "3× Type 2, 5× CCS 2" — compact enough for the driving-extra row.
function formatPlugTypes(plugTypes) {
  return Object.entries(plugTypes || {})
    .map(([type, count]) => `${count}× ${type}`)
    .join(', ');
}

async function loadEvChargingInfo(coords) {
  els.evChargingInfo.classList.remove('hidden');
  els.evChargingInfo.innerHTML = '<div class="driving-extra-title">🔌 EV charging near destination</div><div class="driving-extra-row">Loading…</div>';
  try {
    const res = await fetch(`/api/ev-charging-nearby?lat=${coords.lat}&lon=${coords.lon}`);
    const data = await res.json();
    if (!res.ok || !data.stations || !data.stations.length) {
      els.evChargingInfo.classList.add('hidden');
      return;
    }
    els.evChargingInfo.innerHTML = '<div class="driving-extra-title">🔌 EV charging near destination</div>' + data.stations.map((s) => {
      const label = escapeAttr(s.address || 'EV charging station');
      return `
        <a class="driving-extra-row driving-extra-link-row" href="#" data-lat="${s.lat}" data-lon="${s.lon}" data-label="${label}">
          <span>${s.address} · ${formatDistance(s.distanceMeters)}</span>
          <span class="driving-extra-lots">${formatPlugTypes(s.plugTypes)}</span>
        </a>
      `;
    }).join('') + '<div class="driving-extra-note">Locations from LTA DataMall\'s quarterly dataset — not live availability.</div>';
    wireDrivingExtraLinks(els.evChargingInfo);
  } catch (err) {
    console.error('EV charging info failed:', err);
    els.evChargingInfo.classList.add('hidden');
  }
}

async function loadPetrolInfo(coords) {
  els.petrolInfo.classList.remove('hidden');
  els.petrolInfo.innerHTML = '<div class="driving-extra-title">⛽ Petrol stations near destination</div><div class="driving-extra-row">Loading…</div>';
  try {
    const res = await fetch(`/api/petrol-nearby?lat=${coords.lat}&lon=${coords.lon}`);
    const data = await res.json();
    if (!res.ok || !data.stations || !data.stations.length) {
      els.petrolInfo.classList.add('hidden');
      return;
    }
    els.petrolInfo.innerHTML = '<div class="driving-extra-title">⛽ Petrol stations near destination</div>' + data.stations.map((s) => {
      const label = s.address ? `${s.name} · ${s.address}` : s.name;
      return `
        <a class="driving-extra-row driving-extra-link-row" href="#" data-lat="${s.lat}" data-lon="${s.lon}" data-label="${escapeAttr(label)}">
          <span>${label} · ${formatDistance(s.distanceMeters)}</span>
          <span class="driving-extra-lots">${s.open24h ? '24 hrs' : ''}</span>
        </a>
      `;
    }).join('') + '<div class="driving-extra-note">Locations from OpenStreetMap contributors — not live prices or queues.</div>';
    wireDrivingExtraLinks(els.petrolInfo);
  } catch (err) {
    console.error('Petrol station info failed:', err);
    els.petrolInfo.classList.add('hidden');
  }
}

async function loadErpInfo(coordinates) {
  els.erpInfo.classList.remove('hidden');
  els.erpInfo.innerHTML = '<div class="driving-extra-title">🛣️ ERP</div><div class="driving-extra-row">Checking route…</div>';
  try {
    const res = await fetch('/api/erp-crossings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates }),
    });
    const data = await res.json();
    if (!res.ok || data.gantryCount == null) {
      els.erpInfo.classList.add('hidden');
      return;
    }
    if (data.gantryCount === 0) {
      els.erpInfo.innerHTML = '<div class="driving-extra-title">🛣️ ERP</div><div class="driving-extra-row">No ERP gantries on this route.</div>';
    } else {
      els.erpInfo.innerHTML = '<div class="driving-extra-title">🛣️ ERP</div>'
        + `<div class="driving-extra-row"><span>Gantries on this route</span><span class="driving-extra-lots">${data.gantryCount}</span></div>`
        + '<div class="driving-extra-note">We can flag gantries but not the exact charge yet (LTA doesn\'t publish a route-to-rate link) — charges only apply during operating hours and vary by vehicle type. <a href="https://onemotoring.lta.gov.sg/" target="_blank" rel="noopener">Check current rates</a>.</div>';
    }
  } catch (err) {
    console.error('erp info failed:', err);
    els.erpInfo.classList.add('hidden');
  }
}

// Checks LTA's live speed-band data against the route and, if any stretch is
// jammed or slow-moving, both shows a summary here and stashes the matched
// segments in navTrafficOverlays so the nav map can draw them in red/amber
// on top of the usual blue route line (see drawTrafficOverlays()).
async function loadRouteTraffic(coordinates) {
  els.trafficInfo.classList.remove('hidden');
  els.trafficInfo.innerHTML = '<div class="driving-extra-title">🚦 Traffic</div><div class="driving-extra-row">Checking live conditions…</div>';
  navTrafficOverlays = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('/api/route-traffic', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates }),
    });
    const data = await res.json();
    if (!res.ok || !data.overlays) {
      els.trafficInfo.classList.add('hidden');
      return;
    }
    navTrafficOverlays = data.overlays;
    const { redMeters = 0, amberMeters = 0 } = data.meta || {};
    if (!redMeters && !amberMeters) {
      els.trafficInfo.innerHTML = '<div class="driving-extra-title">🚦 Traffic</div><div class="driving-extra-row">Flowing smoothly along this route.</div>';
    } else {
      const parts = [];
      if (redMeters) parts.push(`<span class="traffic-dot traffic-dot-red"></span>${formatDistance(redMeters)} heavy traffic`);
      if (amberMeters) parts.push(`<span class="traffic-dot traffic-dot-amber"></span>${formatDistance(amberMeters)} slow-moving`);
      els.trafficInfo.innerHTML = '<div class="driving-extra-title">🚦 Traffic</div>'
        + `<div class="driving-extra-row">${parts.join(' &nbsp; ')}</div>`
        + '<div class="driving-extra-note">From LTA\'s live speed data (refreshes every few min) — highlighted on the map once you start navigation.</div>';
    }
    // If navigation is already underway, redraw immediately rather than
    // waiting for the next showNavMap() call.
    if (!els.navMapOverlay.classList.contains('hidden')) drawTrafficOverlays();
  } catch (err) {
    console.error('route traffic failed:', err);
    els.trafficInfo.classList.add('hidden');
  } finally {
    clearTimeout(timeout);
  }
}

async function getDirections() {
  if (!fromCoords || !toCoords) return;
  hideDrivingExtras();

  if (selectedMode === 'transit') return getTransitDirections();

  stopWakeAlert(false);
  clearArrivalIntervalsIn(els.routeSteps);
  els.itineraryOptions.classList.add('hidden');
  els.itineraryOptions.innerHTML = '';
  transitItineraries = [];
  hideRainAlert();

  els.getDirectionsBtn.disabled = true;
  els.getDirectionsBtn.textContent = 'Loading…';

  const coordStr = `${fromCoords.lon},${fromCoords.lat};${toCoords.lon},${toCoords.lat}`;
  // The public OSRM demo server (router.project-osrm.org) only ever runs the
  // car/driving profile — requests with profile "walking" or "cycling" still
  // get routed over car roads at car speeds instead of erroring, which is why
  // walking estimates could come back drastically too fast (a route needing
  // a pedestrian bridge/stairs the car graph doesn't have gets approximated
  // by a nearby road, timed as if driven). FOSSGIS e.V.'s community OSRM
  // mirrors run the actual foot/bike profiles against real pedestrian/cycling
  // network data, so send those two modes there instead.
  const { host, profile } = OSRM_ENDPOINTS[selectedMode] || OSRM_ENDPOINTS.driving;
  const url = `${host}/route/v1/${profile}/${coordStr}?overview=full&geometries=geojson&steps=true`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      showToast('Could not find a route between those points.');
      return;
    }

    const route = data.routes[0];
    hasRoute = true;
    renderRouteSummary(route);
    renderRouteSteps(route);
    if (selectedMode === 'walking') checkRainAlert(fromCoords, toCoords);
    else hideRainAlert();
    if (selectedMode === 'driving') {
      loadParkingInfo(toCoords);
      loadEvChargingInfo(toCoords);
      loadPetrolInfo(toCoords);
      loadErpInfo(route.geometry.coordinates);
      loadRouteTraffic(route.geometry.coordinates);
    } else if (selectedMode === 'cycling') {
      showCyclingExtra();
    }
    // Live turn-by-turn navigation (map + voice + banner) works the same way
    // for driving, cycling, and walking — all three come back from OSRM with
    // real turn-by-turn maneuver steps. Only transit skips it, since that's
    // its own itinerary UI (bus/train legs, not a single walkable route).
    if (selectedMode === 'driving' || selectedMode === 'cycling' || selectedMode === 'walking') {
      navRouteSteps = route.legs.flatMap((leg) => leg.steps);
      navRouteCoords = route.geometry.coordinates;
      els.startNavBtn.classList.remove('hidden');
    }
  } catch (err) {
    console.error(err);
    // A failed fetch is a far more reliable "you're actually offline" signal
    // than navigator.onLine, which is notoriously unreliable — it can report
    // false even on a perfectly working connection (this caused a real bug:
    // switching travel modes with a route already loaded would re-trigger
    // getDirections() and falsely claim "offline" even when fully online).
    // Only show the offline-flavored fallback once the request has actually
    // failed AND the browser also agrees we're offline; otherwise it's some
    // other transient hiccup and the generic message is more honest.
    if (!navigator.onLine) {
      const dist = haversineMeters(fromCoords.lat, fromCoords.lon, toCoords.lat, toCoords.lon);
      const { label } = bearingCompass(fromCoords.lat, fromCoords.lon, toCoords.lat, toCoords.lon);
      showToast(`📡 You're offline — no live routing, but ${toCoords.label || 'your destination'} is roughly ${formatDistanceShort(dist)} to the ${label}.`, 6000);
    } else {
      showToast('Routing service unavailable. Please try again.');
    }
  } finally {
    els.getDirectionsBtn.disabled = false;
    els.getDirectionsBtn.textContent = 'Get Directions';
  }
}

// ---------- Live driving navigation (GPS-tracked, voice-guided turn-by-turn) ----------
// Watches your position and walks through the same steps rendered above,
// speaking each upcoming instruction as you approach it. Deliberately does
// NOT reroute automatically if you go off-path — that needs continuously
// re-querying the routing engine and is a bigger project on its own; instead
// it just flags that you've drifted from the route.

const NAV_ARRIVAL_THRESHOLD_M = 25; // close enough to a maneuver to count as "reached it"
const NAV_OFFROUTE_THRESHOLD_M = 80; // distance from the route line before we warn
const NAV_OFFROUTE_COOLDOWN_MS = 30000; // don't spam the off-route toast

let navRouteSteps = [];
let navRouteCoords = [];
let navWatchId = null;
let navWakeLock = null;
let navTargetIndex = 1; // index into navRouteSteps we're currently heading toward
let navMuted = false;
let navLastOffRouteWarnAt = 0;
let navLastFix = null; // { lat, lon, t } — previous GPS fix, used to derive speed/heading when the browser doesn't report them directly
let navMapRotationDeg = 0; // current course-up rotation applied to the map container (0 = north-up)
let navLastHeadingDeg = null; // most recent known heading, so "recenter" can re-apply rotation immediately instead of waiting for the next GPS fix
let navCompassHeadingDeg = null; // live reading from the phone's own compass/magnetometer, when available
let navCompassActive = false;

// GPS "course over ground" (used above in resolveHeadingDeg) only exists
// once you're actually moving, and can be noisy at walking pace — it can't
// tell you're now facing a different way if you've simply stopped and
// turned around. The device's own compass answers that instantly, which
// matters most for walking (see getCurrentHeadingDeg below, which prefers
// GPS while moving at a normal clip and falls back to the compass
// otherwise). iOS requires an explicit permission prompt, which has to be
// triggered directly from a user gesture — this is called synchronously
// from the "Start Navigation" tap handler for exactly that reason.
function handleDeviceOrientation(event) {
  let heading = null;
  if (typeof event.webkitCompassHeading === 'number') {
    // iOS Safari reports a true compass heading directly, no conversion needed.
    heading = event.webkitCompassHeading;
  } else if (event.absolute && typeof event.alpha === 'number') {
    // deviceorientationabsolute's alpha increases counter-clockwise from
    // north; compass headings increase clockwise, hence the flip.
    heading = (360 - event.alpha) % 360;
  }
  if (Number.isFinite(heading)) navCompassHeadingDeg = heading;
}

function startCompassListener() {
  if (navCompassActive || typeof DeviceOrientationEvent === 'undefined') return;
  const attach = () => {
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', handleDeviceOrientation);
    } else {
      window.addEventListener('deviceorientation', handleDeviceOrientation);
    }
    navCompassActive = true;
  };
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then((state) => { if (state === 'granted') attach(); })
      .catch((err) => console.error('compass permission request failed:', err));
  } else {
    attach();
  }
}

function stopCompassListener() {
  if (!navCompassActive) return;
  window.removeEventListener('deviceorientationabsolute', handleDeviceOrientation);
  window.removeEventListener('deviceorientation', handleDeviceOrientation);
  navCompassActive = false;
  navCompassHeadingDeg = null;
}

// Visual map — Leaflet, loaded from a CDN (see index.html). Lazily created on
// the first "Start Navigation" tap, then reused/repositioned for later trips
// rather than rebuilt each time.
let navMap = null;
let navMapRouteHalo = null; // a wider white line drawn under navMapRouteLine so the route reads clearly against busy OSM tiles
let navMapRouteLine = null;
let navMapLiveMarker = null;
let navMapStartMarker = null;
let navMapDestMarker = null;
let navFollowing = true; // false once the user manually drags the map, until they tap recenter

// Live-traffic overlay segments matched against the current route by
// /api/route-traffic (see loadRouteTraffic()) — [{ color: 'red'|'amber',
// points: [[lat,lon], ...] }]. Drawn on top of navMapRouteLine.
let navTrafficOverlays = [];
let navMapTrafficLines = [];

function drawTrafficOverlays() {
  if (!navMap) return;
  navMapTrafficLines.forEach((line) => navMap.removeLayer(line));
  navMapTrafficLines = [];
  const colors = { red: '#dc2626', amber: '#f59e0b' };
  navTrafficOverlays.forEach((overlay) => {
    const line = L.polyline(overlay.points, {
      color: colors[overlay.color] || colors.red,
      weight: 7,
      opacity: 0.9,
    }).addTo(navMap);
    line.bringToFront();
    navMapTrafficLines.push(line);
  });
}

function initNavMap() {
  if (navMap || typeof L === 'undefined') return;
  navMap = L.map('navMap', { zoomControl: false, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(navMap);
  // Manually panning away breaks course-up tracking — freeze back to a
  // plain north-up map rather than leaving it stuck at a rotated angle
  // while the person's looking somewhere else on it.
  navMap.on('dragstart', () => { navFollowing = false; resetMapRotation(); });
}

function showNavMap(routeCoords) {
  if (typeof L === 'undefined') return; // Leaflet didn't load (e.g. no connection to the CDN) — nav still works via the banner/voice, just no map
  els.navMapOverlay.classList.remove('hidden');
  initNavMap();
  if (!navMap) return;
  // The container was just un-hidden, so Leaflet needs a nudge to notice its real size.
  setTimeout(() => navMap.invalidateSize(), 0);

  if (navMapRouteHalo) { navMap.removeLayer(navMapRouteHalo); navMapRouteHalo = null; }
  if (navMapRouteLine) { navMap.removeLayer(navMapRouteLine); navMapRouteLine = null; }
  const latlngs = routeCoords.map(([lon, lat]) => [lat, lon]);
  // A wider white "halo" drawn underneath the blue line so the route still
  // reads clearly against busy/light OSM tiles (car parks, building fills,
  // etc.) instead of a thin line getting lost in the background.
  navMapRouteHalo = L.polyline(latlngs, { color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(navMap);
  navMapRouteLine = L.polyline(latlngs, { color: '#2563eb', weight: 5, opacity: 0.95 }).addTo(navMap);
  navMap.fitBounds(navMapRouteLine.getBounds(), { padding: [40, 40] });
  drawTrafficOverlays();

  // Start (A) and destination (B) markers — separate from the live puck,
  // which tracks current position and moves away from the start point as
  // soon as you set off. Without a destination pin there's nothing on the
  // map anchoring "this is where you're headed."
  if (!navMapStartMarker) {
    const startIcon = L.divIcon({ className: 'nav-start-marker', iconSize: [14, 14], iconAnchor: [7, 7] });
    navMapStartMarker = L.marker(latlngs[0], { icon: startIcon, zIndexOffset: 900 }).addTo(navMap);
  } else {
    navMapStartMarker.setLatLng(latlngs[0]);
  }
  const destLatLng = latlngs[latlngs.length - 1];
  if (!navMapDestMarker) {
    const destIcon = L.divIcon({ className: 'nav-dest-marker', html: '📍', iconSize: [28, 28], iconAnchor: [14, 28] });
    navMapDestMarker = L.marker(destLatLng, { icon: destIcon, zIndexOffset: 950 }).addTo(navMap);
  } else {
    navMapDestMarker.setLatLng(destLatLng);
  }

  if (!navMapLiveMarker) {
    const liveIcon = L.divIcon({
      className: 'nav-live-puck',
      html: '<div class="nav-live-puck-arrow"></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    navMapLiveMarker = L.marker(latlngs[0], { icon: liveIcon, zIndexOffset: 1000 }).addTo(navMap);
  } else {
    navMapLiveMarker.setLatLng(latlngs[0]);
  }
  navFollowing = true;
  els.navSpeedBadge.classList.remove('hidden');
  els.navBottomSheet.classList.remove('hidden');
  els.navCompass.classList.remove('hidden');
  navLastFix = null;
  navLastHeadingDeg = null;
  resetMapRotation();
}

// Rotates the live puck's arrow to face `heading` (degrees, 0 = north,
// clockwise) when known — falls back to leaving it as last-set if the GPS
// fix doesn't include a heading (common when stationary or on some devices).
// This stays correct whether or not the map itself is currently rotated
// (course-up below): the arrow's rotation is relative to its own parent
// pane, and that pane's rotation is what handles reorienting "north" —
// composing the two always lands the arrow pointing the right way.
function updateNavPuckHeading(heading) {
  if (!navMapLiveMarker || !Number.isFinite(heading)) return;
  const el = navMapLiveMarker.getElement();
  const arrow = el && el.querySelector('.nav-live-puck-arrow');
  if (arrow) arrow.style.transform = `rotate(${heading}deg)`;
}

// "Course-up" rotation — spins the whole map so the direction you're
// currently heading always points to the top of the screen, the way
// Waze/Google Maps do by default, instead of a fixed north-up map that
// needs mentally re-orienting (or physically turning the phone) to match
// which way you're actually walking/driving.
//
// This is a plain CSS rotation of Leaflet's own container, not a "real"
// map-projection rotation (that needs a rotation-aware Leaflet build) — the
// tradeoff is that road/place labels rotate along with everything else and
// can end up sideways or upside-down. Only applied while actively
// following your position; panning away freezes back to north-up (see
// dragstart above) so you're not fighting a spinning map while looking
// around it.
function applyCourseUpRotation(headingDeg) {
  if (!navMap || !navFollowing || !Number.isFinite(headingDeg)) return;
  navMapRotationDeg = -headingDeg;
  navMap.getContainer().style.transform = `rotate(${navMapRotationDeg}deg)`;
  els.navCompassNeedle.style.transform = `rotate(${navMapRotationDeg}deg)`;
}

function resetMapRotation() {
  navMapRotationDeg = 0;
  if (navMap) navMap.getContainer().style.transform = '';
  if (els.navCompassNeedle) els.navCompassNeedle.style.transform = '';
}

function updateNavMapPosition(lat, lon) {
  if (!navMap || !navMapLiveMarker) return;
  navMapLiveMarker.setLatLng([lat, lon]);
  if (navFollowing) navMap.setView([lat, lon], Math.max(navMap.getZoom(), 16), { animate: true });
}

function hideNavMap() {
  els.navMapOverlay.classList.add('hidden');
  els.navSpeedBadge.classList.add('hidden');
  els.navBottomSheet.classList.add('hidden');
  els.navCompass.classList.add('hidden');
  navLastFix = null;
}

if (els.navRecenterBtn) {
  els.navRecenterBtn.addEventListener('click', () => {
    navFollowing = true;
    if (navMap && navMapLiveMarker) navMap.setView(navMapLiveMarker.getLatLng(), 16, { animate: true });
    // Re-apply course-up immediately from the last known heading rather than
    // sitting north-up until the next GPS fix happens to arrive.
    if (Number.isFinite(navLastHeadingDeg)) applyCourseUpRotation(navLastHeadingDeg);
  });
}

function navStepInstruction(step) {
  const name = step.name ? ` onto ${step.name}` : '';
  return `${stepVerb(step.maneuver)}${name}`;
}

function speakNav(text) {
  if (navMuted || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utter);
  } catch (err) {
    console.error('speech synthesis failed:', err);
  }
}

function distanceToRouteLine(lat, lon) {
  // Cheap approximation: closest of the route's polyline vertices, not a true
  // point-to-segment distance — good enough at typical GPS/road sample density.
  let min = Infinity;
  for (const [clon, clat] of navRouteCoords) {
    const d = haversineMeters(lat, lon, clat, clon);
    if (d < min) min = d;
  }
  return min;
}

function updateNavBanner(distanceM, step) {
  els.navBannerDistance.textContent = formatDistance(distanceM);
  els.navBannerInstruction.textContent = navStepInstruction(step);
  els.navBannerIcon.textContent = stepIcon(step.maneuver);
}

function highlightNavStep(index) {
  els.routeSteps.querySelectorAll('.nav-current-step').forEach((li) => li.classList.remove('nav-current-step'));
  const li = document.getElementById(`route-step-${index}`);
  if (li) {
    li.classList.add('nav-current-step');
    li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Speed: prefer the GPS fix's own reading (m/s — only present on
// devices/browsers that report it), fall back to distance/time between the
// last two fixes otherwise.
function resolveSpeedKmh(pos) {
  const { speed, latitude: lat, longitude: lon } = pos.coords;
  if (Number.isFinite(speed) && speed >= 0) return speed * 3.6;
  if (navLastFix) {
    const dt = (pos.timestamp - navLastFix.t) / 1000;
    if (dt > 0.5) {
      const d = haversineMeters(navLastFix.lat, navLastFix.lon, lat, lon);
      return (d / dt) * 3.6;
    }
  }
  return null;
}

// Heading: prefer the GPS fix's own reading, fall back to the bearing
// between the last two fixes (skipped over tiny movements, since bearing
// across a couple of metres of GPS jitter is mostly noise).
function resolveHeadingDeg(pos) {
  const { heading, latitude: lat, longitude: lon } = pos.coords;
  if (Number.isFinite(heading)) return heading;
  if (navLastFix) {
    const d = haversineMeters(navLastFix.lat, navLastFix.lon, lat, lon);
    if (d > 3) return bearingCompass(navLastFix.lat, navLastFix.lon, lat, lon).degrees;
  }
  return null;
}

function updateSpeedBadge(speedKmh) {
  els.navSpeedValue.textContent = Number.isFinite(speedKmh) ? String(Math.round(Math.max(0, speedKmh))) : '–';
}

// GPS course-over-ground (resolveHeadingDeg) is the more stable reading
// once you're actually moving at a normal pace — a phone's compass can be
// thrown off by nearby metal/electronics, which matters most in a car. But
// GPS course is unavailable or noisy below walking speed, including
// standing still and just turning to face a different way — exactly when
// the compass is most useful, since it doesn't need any movement at all.
function getCurrentHeadingDeg(pos, speedKmh) {
  const gpsHeading = resolveHeadingDeg(pos);
  if (Number.isFinite(gpsHeading) && Number.isFinite(speedKmh) && speedKmh > 3) return gpsHeading;
  if (Number.isFinite(navCompassHeadingDeg)) return navCompassHeadingDeg;
  return gpsHeading;
}

// Remaining distance/duration from the current fix: the airline distance to
// the upcoming maneuver (a reasonable stand-in for "remaining on this
// step"), plus every step still ahead of it in full — same estimate style
// OSRM's own duration figures already use.
function updateEtaSheet(distToTarget, target) {
  let remainingDist = distToTarget;
  let remainingDuration = target.distance > 0
    ? target.duration * Math.min(1, distToTarget / target.distance)
    : 0;
  for (let i = navTargetIndex + 1; i < navRouteSteps.length; i++) {
    remainingDist += navRouteSteps[i].distance;
    remainingDuration += navRouteSteps[i].duration;
  }
  els.navRemainingDuration.textContent = formatDuration(remainingDuration);
  els.navRemainingDistance.textContent = formatDistance(remainingDist);
  const eta = new Date(Date.now() + remainingDuration * 1000);
  els.navEta.textContent = eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function handleNavPosition(pos) {
  if (!navRouteSteps.length) return;
  const { latitude: lat, longitude: lon } = pos.coords;

  const speedKmh = resolveSpeedKmh(pos);
  const headingDeg = getCurrentHeadingDeg(pos, speedKmh);
  updateNavMapPosition(lat, lon);
  updateNavPuckHeading(headingDeg);
  applyCourseUpRotation(headingDeg);
  if (Number.isFinite(headingDeg)) navLastHeadingDeg = headingDeg;
  updateSpeedBadge(speedKmh);

  const target = navRouteSteps[navTargetIndex];
  const [tlon, tlat] = target.maneuver.location;
  const distToTarget = haversineMeters(lat, lon, tlat, tlon);

  updateNavBanner(distToTarget, target);
  updateEtaSheet(distToTarget, target);
  highlightNavStep(navTargetIndex);
  navLastFix = { lat, lon, t: pos.timestamp };

  const offRoute = distanceToRouteLine(lat, lon) > NAV_OFFROUTE_THRESHOLD_M;
  if (offRoute && Date.now() - navLastOffRouteWarnAt > NAV_OFFROUTE_COOLDOWN_MS) {
    navLastOffRouteWarnAt = Date.now();
    showToast("You look off-route — Waypoint won't reroute automatically, get new directions if needed.");
  }

  if (distToTarget <= NAV_ARRIVAL_THRESHOLD_M) {
    if (navTargetIndex >= navRouteSteps.length - 1) {
      speakNav('You have arrived at your destination.');
      stopNavigation(false);
      // "Save parked car" only makes sense after driving — there's no car
      // to remember the spot of on a bike or on foot.
      if (selectedMode === 'driving') {
        saveParkedCar(lat, lon);
        showToast('🅿️ You have arrived — parking spot saved to ★ Favourites.');
      } else {
        const arrivedIcon = selectedMode === 'walking' ? '🚶' : '🚲';
        showToast(`${arrivedIcon} You have arrived at your destination.`);
      }
      return;
    }
    navTargetIndex += 1;
    const next = navRouteSteps[navTargetIndex];
    speakNav(navStepInstruction(next));
  }
}

async function startNavigation() {
  if (!navigator.geolocation) {
    showToast('Geolocation is not supported by your browser.');
    return;
  }
  if (!navRouteSteps.length) return;

  navTargetIndex = navRouteSteps.length > 1 ? 1 : 0;
  navLastOffRouteWarnAt = 0;

  // Must be called synchronously, directly from this click handler — iOS
  // only shows the compass permission prompt when requested straight from
  // a user gesture, not after an await.
  startCompassListener();

  showNavMap(navRouteCoords);
  els.navBanner.classList.remove('hidden');
  els.navMuteBtn.textContent = navMuted ? '🔇' : '🔊';
  els.navBannerDistance.textContent = 'Locating…';
  els.navBannerInstruction.textContent = navStepInstruction(navRouteSteps[navTargetIndex]);
  els.navBannerIcon.textContent = stepIcon(navRouteSteps[navTargetIndex].maneuver);
  highlightNavStep(navTargetIndex);
  speakNav(`Starting navigation. ${navStepInstruction(navRouteSteps[navTargetIndex])}`);

  if ('wakeLock' in navigator) {
    try {
      navWakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.error('wake lock failed:', err); // non-fatal — screen may just dim/sleep during nav
    }
  }

  navWatchId = navigator.geolocation.watchPosition(
    handleNavPosition,
    (err) => {
      console.error('navigation geolocation error:', err);
      showToast(geoErrorMessage(err) + ' (needed for live navigation)');
      stopNavigation(false);
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
}

function stopNavigation(showMsg) {
  if (navWatchId != null) {
    navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
  }
  if (navWakeLock) {
    navWakeLock.release().catch(() => {});
    navWakeLock = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  stopCompassListener();
  els.navBanner.classList.add('hidden');
  hideNavMap();
  els.routeSteps.querySelectorAll('.nav-current-step').forEach((li) => li.classList.remove('nav-current-step'));
  if (showMsg) showToast('Navigation stopped.');
}

els.startNavBtn.addEventListener('click', startNavigation);
els.navStopBtn.addEventListener('click', () => stopNavigation(true));
els.navMuteBtn.addEventListener('click', () => {
  navMuted = !navMuted;
  els.navMuteBtn.textContent = navMuted ? '🔇' : '🔊';
  if (navMuted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
});

// ---------- Transit (bus / MRT) directions ----------

const MODE_ICON = { walk: '🚶', bus: '🚌', train: '🚇', ferry: '⛴' };

// Friendlier tooltip names for MRT/LRT line codes. Purely cosmetic — the
// actual badge color always comes from the live GTFS feed (leg.routeColor),
// never hardcoded here, so a brand-new line (or a color change) shows up
// correctly with zero code changes on our end.
const MRT_LINE_NAMES = {
  NS: 'North South Line', EW: 'East West Line', CG: 'East West Line (Changi Airport)',
  NE: 'North East Line', CC: 'Circle Line', CE: 'Circle Line (Marina Bay)',
  DT: 'Downtown Line', TE: 'Thomson-East Coast Line',
  BP: 'Bukit Panjang LRT', SE: 'Sengkang LRT', SW: 'Sengkang LRT', PE: 'Punggol LRT', PW: 'Punggol LRT',
};

// Picks black or white text for readability against an arbitrary line
// color (standard relative-luminance formula) — only used as a fallback
// when the feed doesn't supply its own textColor.
function contrastTextColor(hex) {
  if (!hex || hex.length !== 6) return '#fff';
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#000' : '#fff';
}

// A small colored pill for a train leg, e.g. "DT" on blue, "TE" on brown —
// matches the real MRT/LRT line colors from the live GTFS feed.
function lineBadge(leg) {
  const badge = document.createElement('span');
  badge.className = 'line-badge';
  badge.style.background = leg.routeColor ? `#${leg.routeColor}` : '#666';
  badge.style.color = leg.routeTextColor ? `#${leg.routeTextColor}` : contrastTextColor(leg.routeColor);
  badge.textContent = leg.routeName || '?';
  if (leg.routeName && MRT_LINE_NAMES[leg.routeName]) badge.title = MRT_LINE_NAMES[leg.routeName];
  return badge;
}

let transitItineraries = []; // all itinerary options returned for the current transit search
let selectedItineraryIndex = 0;

async function getTransitDirections() {
  stopWakeAlert(false);
  hideRainAlert();
  els.getDirectionsBtn.disabled = true;
  els.getDirectionsBtn.textContent = 'Loading…';

  const params = new URLSearchParams({
    fromLat: fromCoords.lat, fromLon: fromCoords.lon,
    toLat: toCoords.lat, toLon: toCoords.lon,
  });

  try {
    const res = await fetch(`/api/transit-plan?${params}`);
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Transit routing is unavailable right now.');
      return;
    }

    if (!data.itineraries || !data.itineraries.length) {
      const reason = data.errors?.[0]?.description;
      showToast(reason || 'No bus/MRT route found between those points.');
      els.itineraryOptions.classList.add('hidden');
      els.itineraryOptions.innerHTML = '';
      transitItineraries = [];
      return;
    }

    // The server already sorts these — fastest first, with a modest priority
    // boost for MRT/LRT-inclusive routes (rail is generally faster and less
    // traffic-prone than an all-bus trip, so it's shown/selected by default
    // even when a bus option is a few minutes quicker on paper). Trust that
    // order here rather than re-sorting by raw duration, which would undo it.
    transitItineraries = [...data.itineraries];
    renderItineraryOptions();
    selectItinerary(0);
    checkRainAlert(fromCoords, toCoords); // transit always includes walk legs to/from stops
  } catch (err) {
    console.error(err);
    showToast('Transit routing service unavailable. Please try again.');
  } finally {
    els.getDirectionsBtn.disabled = false;
    els.getDirectionsBtn.textContent = 'Get Directions';
  }
}

// Renders the list of alternative itineraries as selectable cards, e.g.
// "🚶 → 🚇 → 🚶   32 min   5:38p–6:10p". Clicking a card switches the
// summary and step list to that option.
function renderItineraryOptions() {
  els.itineraryOptions.innerHTML = '';

  if (transitItineraries.length < 2) {
    els.itineraryOptions.classList.add('hidden');
    if (els.itineraryOptionsLabel) els.itineraryOptionsLabel.classList.add('hidden');
    return;
  }

  els.itineraryOptions.classList.remove('hidden');

  // Easy to miss that the fastest pick isn't the only option (e.g. an
  // MRT+bus alternative a couple minutes slower than the top all-bus
  // pick) — flag how many others there are to compare.
  if (els.itineraryOptionsLabel) {
    const moreCount = transitItineraries.length - 1;
    els.itineraryOptionsLabel.textContent = `${moreCount} more option${moreCount === 1 ? '' : 's'}`;
    els.itineraryOptionsLabel.classList.remove('hidden');
  }

  // The server may put an MRT/LRT-inclusive itinerary first even when it's
  // not literally the quickest by the clock (rail gets a modest priority
  // boost over bus — see server.js). So "Fastest" needs to track actual
  // duration, not just array position, or it'd mislabel a slower option.
  const fastestDuration = Math.min(...transitItineraries.map((it) => it.duration));

  transitItineraries.forEach((itinerary, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'itinerary-option' + (i === selectedItineraryIndex ? ' active' : '');

    const modes = document.createElement('span');
    modes.className = 'io-modes';
    const transitLegs = itinerary.legs.filter((l) => l.mode !== 'walk');
    transitLegs.forEach((leg, idx) => {
      if (idx > 0) {
        const sep = document.createElement('span');
        sep.className = 'io-sep';
        sep.textContent = '›';
        modes.appendChild(sep);
      }
      if (leg.mode === 'train' && leg.routeColor) {
        modes.appendChild(lineBadge(leg));
      } else {
        const icon = document.createElement('span');
        icon.textContent = MODE_ICON[leg.mode] || '➜';
        modes.appendChild(icon);
      }
    });

    const main = document.createElement('span');
    main.className = 'io-main';
    const duration = document.createElement('span');
    duration.className = 'io-duration';
    duration.textContent = formatDuration(itinerary.duration);
    const time = document.createElement('span');
    time.className = 'io-time';
    time.textContent = `${formatClockTime(itinerary.startTime)} – ${formatClockTime(itinerary.endTime)}`;
    main.appendChild(duration);
    main.appendChild(time);
    if (itinerary.fareEstimate != null) {
      const fare = document.createElement('span');
      fare.className = 'io-fare';
      fare.textContent = formatFare(itinerary.fareEstimate);
      main.appendChild(fare);
    }

    const transferCount = Math.max(transitLegs.length - 1, 0);
    const transferText = transferCount > 0 ? `${transferCount} transfer${transferCount > 1 ? 's' : ''}` : 'Direct';
    const isFastest = itinerary.duration === fastestDuration;
    const hasRail = transitLegs.some((l) => l.mode === 'train');
    const isRecommendedPick = i === 0 && !isFastest && hasRail;

    const badge = document.createElement('span');
    badge.className = 'io-badge' + (isFastest || isRecommendedPick ? ' io-badge-fastest' : '');
    if (isFastest) badge.textContent = `Fastest · ${transferText}`;
    else if (isRecommendedPick) badge.textContent = `🚇 Recommended · ${transferText}`;
    else badge.textContent = transferText;

    card.appendChild(modes);
    card.appendChild(main);
    card.appendChild(badge);

    card.addEventListener('click', () => selectItinerary(i));
    els.itineraryOptions.appendChild(card);
  });
}

function selectItinerary(index) {
  selectedItineraryIndex = index;
  const itinerary = transitItineraries[index];
  if (!itinerary) return;

  els.itineraryOptions.querySelectorAll('.itinerary-option').forEach((card, i) => {
    card.classList.toggle('active', i === index);
  });

  hasRoute = true;
  renderTransitSummary(itinerary);
  renderTransitSteps(itinerary);
}

function formatClockTime(ms) {
  return new Date(ms).toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// Adult card fare estimate — see the matching table on the server
// (/api/transit-plan). Approximate: actual fare depends on peak/off-peak
// timing and any promotions, so it's always shown with a "~" prefix.
function formatFare(fare) {
  return `~$${fare.toFixed(2)}`;
}

function renderTransitSummary(itinerary) {
  els.routeSummary.classList.remove('hidden');
  const transfers = itinerary.legs.filter((l) => l.mode !== 'walk').length;
  const transferText = transfers > 1 ? `${transfers - 1} transfer${transfers > 2 ? 's' : ''}` : 'Direct';
  const fareText = itinerary.fareEstimate != null ? ` &nbsp;·&nbsp; ${formatFare(itinerary.fareEstimate)}` : '';
  els.routeSummary.innerHTML = `<strong>${formatDuration(itinerary.duration)}</strong> &nbsp;·&nbsp; `
    + `${formatClockTime(itinerary.startTime)} – ${formatClockTime(itinerary.endTime)} &nbsp;·&nbsp; ${transferText}${fareText}`;
}

function renderTransitSteps(itinerary) {
  stopWakeAlert(false); // old leg buttons are about to be torn down
  clearArrivalIntervalsIn(els.routeSteps); // old arrivals panels are about to be torn down
  els.routeSteps.innerHTML = '';
  itinerary.legs.forEach((leg) => {
    const li = document.createElement('li');
    li.className = 'route-step';

    const row = document.createElement('div');
    row.className = 'route-step-row';

    const useLineBadge = leg.mode === 'train' && leg.routeColor;
    const icon = useLineBadge ? lineBadge(leg) : document.createElement('span');
    if (!useLineBadge) {
      icon.className = 'step-num';
      icon.textContent = MODE_ICON[leg.mode] || '➜';
    } else {
      icon.classList.add('step-num-badge');
    }

    const text = document.createElement('span');
    if (leg.mode === 'walk') {
      const toCode = leg.toStopCode ? ` (Bus Stop ${leg.toStopCode})` : '';
      text.textContent = `Walk to ${leg.to}${toCode} — ${formatDistance(leg.distance)}, ${formatDuration(leg.duration)}`;
    } else {
      // For a train leg with a real line badge already showing "DT"/"TE"/etc,
      // don't repeat "Line DT" in the text too — just the full line name if
      // we know it, otherwise fall back to the raw code like before.
      const line = leg.mode === 'train'
        ? (useLineBadge && MRT_LINE_NAMES[leg.routeName] ? MRT_LINE_NAMES[leg.routeName] : (leg.routeName ? `Line ${leg.routeName}` : leg.mode))
        : (leg.routeName ? `Bus ${leg.routeName}` : leg.mode);
      const headsign = leg.headsign ? ` towards ${leg.headsign}` : '';
      const fromCode = leg.fromStopCode ? ` (${leg.fromStopCode})` : '';
      const toCode = leg.toStopCode ? ` (${leg.toStopCode})` : '';
      text.innerHTML = `<strong>${line}</strong>${headsign}<br>`
        + `${leg.from}${fromCode} → ${leg.to}${toCode} — ${formatDuration(leg.duration)} (${formatClockTime(leg.startTime)})`;
    }
    row.appendChild(icon);
    row.appendChild(text);
    li.appendChild(row);

    // "Wake me up" alert: only makes sense on a bus/train leg with a real
    // alighting-stop location to watch your live position against.
    if (leg.mode !== 'walk' && leg.toLat != null && leg.toLon != null) {
      const wakeRow = document.createElement('div');
      wakeRow.className = 'step-wake-row';

      const wakeBtn = document.createElement('button');
      wakeBtn.type = 'button';
      wakeBtn.className = 'wake-btn';
      wakeBtn.textContent = '🔔 Wake me up';

      const status = document.createElement('span');
      status.className = 'wake-status';

      wakeBtn.addEventListener('click', () => toggleWakeAlert(leg, wakeBtn, status));

      wakeRow.appendChild(wakeBtn);
      wakeRow.appendChild(status);
      li.appendChild(wakeRow);
    }

    // Live arrivals for every bus service at this leg's boarding stop — not
    // just the one route in the itinerary, so you can see if an earlier bus
    // works too.
    if (leg.mode === 'bus' && leg.fromStopCode) {
      const arrivalsRow = document.createElement('div');
      arrivalsRow.className = 'step-arrivals-row';

      const btnRow = document.createElement('div');
      btnRow.className = 'step-arrivals-btn-row';

      const arrivalsBtn = document.createElement('button');
      arrivalsBtn.type = 'button';
      arrivalsBtn.className = 'arrivals-btn';
      arrivalsBtn.textContent = '🚌 Live arrivals';

      const favBtn = document.createElement('button');
      favBtn.type = 'button';
      favBtn.className = 'fav-quick-btn';
      favBtn.title = 'Save to Favourites';
      favBtn.textContent = isFavourite(leg.fromStopCode) ? '★' : '☆';
      favBtn.addEventListener('click', () => {
        toggleFavourite({ code: leg.fromStopCode, name: leg.from });
        favBtn.textContent = isFavourite(leg.fromStopCode) ? '★' : '☆';
      });

      const panel = document.createElement('div');
      panel.className = 'arrivals-panel hidden';

      arrivalsBtn.addEventListener('click', () => toggleArrivalsPanel(leg.fromStopCode, arrivalsBtn, panel));

      btnRow.appendChild(arrivalsBtn);
      btnRow.appendChild(favBtn);
      arrivalsRow.appendChild(btnRow);
      arrivalsRow.appendChild(panel);
      li.appendChild(arrivalsRow);
    }

    els.routeSteps.appendChild(li);
  });
}

function formatDuration(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h} hr ${m} min`;
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function renderRouteSummary(route) {
  els.routeSummary.classList.remove('hidden');
  els.routeSummary.innerHTML = `<strong>${formatDuration(route.duration)}</strong> &nbsp;·&nbsp; ${formatDistance(route.distance)}`;
}

const STEP_ICONS = {
  depart: '🚩', arrive: '🏁', turn: '↪', merge: '↗', roundabout: '⟳',
  'roundabout turn': '⟳', fork: '⑂', 'end of road': '⤴', continue: '⬆',
  new_name: '⬆', notification: 'ℹ', default: '➜'
};

function stepIcon(maneuver) {
  return STEP_ICONS[maneuver.type] || STEP_ICONS.default;
}

function stepVerb(maneuver) {
  return maneuver.type === 'depart' ? 'Head out'
    : maneuver.type === 'arrive' ? 'Arrive at destination'
    : `${maneuver.type.replace(/_/g, ' ')}${maneuver.modifier ? ' ' + maneuver.modifier : ''}`;
}

function renderRouteSteps(route) {
  els.routeSteps.innerHTML = '';
  const steps = route.legs.flatMap(leg => leg.steps);
  steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.id = `route-step-${i}`;
    li.dataset.stepIndex = String(i);
    const num = document.createElement('span');
    num.className = 'step-num';
    num.textContent = stepIcon(step.maneuver);
    const text = document.createElement('span');
    const name = step.name ? ` onto ${step.name}` : '';
    text.textContent = `${stepVerb(step.maneuver)}${name} — ${formatDistance(step.distance)}`;
    li.appendChild(num);
    li.appendChild(text);
    els.routeSteps.appendChild(li);
  });
}

// ---------- "Wake me up" — alerts you as you approach a bus/train alighting stop ----------
// Watches your live GPS position against the leg's destination stop and beeps +
// vibrates + shows a banner once you're close, repeating until dismissed — useful
// if you doze off on a long bus ride.

const WAKE_ALERT_THRESHOLD_M = 300; // distance to alighting stop that triggers the alert
const WAKE_REPEAT_MS = 8000; // how often to re-beep while the banner is up, undismissed

let wakeState = null; // { watchId, repeatTimer, btnEl, statusEl, targetName, triggered, stops, stopCursor }
let wakeAudioCtx = null;
let wakeWakeLock = null; // screen wake lock — keeps the tab foregrounded/tracking while armed

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Straight-line compass direction from point 1 to point 2, as an 8-point
// compass label (N/NE/E/...). Used as an offline fallback when OSRM routing
// isn't reachable — GPS still works with no signal, turn-by-turn doesn't.
function bearingCompass(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const bearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const label = points[Math.round(bearingDeg / 45) % 8];
  return { degrees: Math.round(bearingDeg), label };
}

function formatDistanceShort(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function playWakeBeep() {
  try {
    if (!wakeAudioCtx) wakeAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (wakeAudioCtx.state === 'suspended') wakeAudioCtx.resume();
    const now = wakeAudioCtx.currentTime;
    [0, 0.3, 0.6].forEach((offset) => {
      const osc = wakeAudioCtx.createOscillator();
      const gain = wakeAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      osc.connect(gain);
      gain.connect(wakeAudioCtx.destination);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.35, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.25);
      osc.start(now + offset);
      osc.stop(now + offset + 0.3);
    });
  } catch (err) {
    console.error('beep failed:', err);
  }
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
}

function toggleWakeAlert(leg, btnEl, statusEl) {
  if (wakeState && wakeState.btnEl === btnEl) {
    stopWakeAlert(true);
    return;
  }
  startWakeAlert(leg, btnEl, statusEl);
}

async function startWakeAlert(leg, btnEl, statusEl) {
  if (!navigator.geolocation) {
    showToast('Geolocation is not supported by your browser.');
    return;
  }
  stopWakeAlert(false); // only one active watch at a time

  // Keep the screen on while the alert is armed — without this, mobile
  // browsers dim/lock the screen and then suspend the background tab,
  // silently killing the geolocation watch (the #1 reason this alert
  // wouldn't fire). Same approach turn-by-turn nav already uses.
  if ('wakeLock' in navigator) {
    try {
      wakeWakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.error('wake lock failed:', err); // non-fatal — screen may just dim/sleep
    }
  }

  const targetName = leg.to || 'your stop';
  // leg.stops is the full boarding-to-alighting stop sequence (from server.js,
  // via OTP's intermediateStops) — used to count down remaining stops, not
  // just distance. Falls back to distance-only if it's missing or too short
  // to be meaningful (e.g. an older cached itinerary from before this shipped).
  const stops = Array.isArray(leg.stops) && leg.stops.length >= 2 ? leg.stops : null;
  wakeState = {
    watchId: null, repeatTimer: null, btnEl, statusEl, targetName, triggered: false,
    stops, stopCursor: 0,
  };
  btnEl.textContent = '🔕 Cancel alert';
  btnEl.classList.add('active');
  statusEl.textContent = 'Locating you…';
  showToast(`We'll wake you up near ${targetName}.`);

  wakeState.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!wakeState) return;
      const dist = haversineMeters(pos.coords.latitude, pos.coords.longitude, leg.toLat, leg.toLon);

      let stopsText = '';
      if (wakeState.stops) {
        const { lat, lon } = pos.coords;
        const lastIdx = wakeState.stops.length - 1;
        // Advance past any stop we're now clearly closer to the NEXT stop
        // than to it — handles sparse GPS updates (e.g. bus passed 2 stops
        // between fixes) by looping rather than only checking one step.
        while (wakeState.stopCursor < lastIdx) {
          const cur = wakeState.stops[wakeState.stopCursor];
          const next = wakeState.stops[wakeState.stopCursor + 1];
          if (cur.lat == null || cur.lon == null || next.lat == null || next.lon == null) break;
          const distCur = haversineMeters(lat, lon, cur.lat, cur.lon);
          const distNext = haversineMeters(lat, lon, next.lat, next.lon);
          if (distNext < distCur) wakeState.stopCursor += 1;
          else break;
        }
        const stopsRemaining = lastIdx - wakeState.stopCursor;
        if (stopsRemaining > 0) {
          stopsText = ` · ${stopsRemaining} stop${stopsRemaining === 1 ? '' : 's'} to go`;
        } else {
          stopsText = ' · next stop';
        }
      }

      wakeState.statusEl.textContent = `📍 ${formatDistance(dist)} to ${targetName}${stopsText}`;
      if (dist <= WAKE_ALERT_THRESHOLD_M && !wakeState.triggered) {
        wakeState.triggered = true;
        triggerWakeAlert(targetName);
      }
    },
    (err) => {
      console.error('wake-alert geolocation error:', err);
      showToast(geoErrorMessage(err) + ' (needed for the wake-up alert)');
      stopWakeAlert(false);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function triggerWakeAlert(targetName) {
  playWakeBeep();
  els.wakeAlertText.textContent = `Approaching ${targetName} — get ready to alight!`;
  els.wakeAlert.classList.remove('hidden');
  if (wakeState) {
    clearInterval(wakeState.repeatTimer);
    wakeState.repeatTimer = setInterval(playWakeBeep, WAKE_REPEAT_MS);
  }
}

function stopWakeAlert(showMsg) {
  if (!wakeState) {
    els.wakeAlert.classList.add('hidden');
    return;
  }
  if (wakeState.watchId != null) navigator.geolocation.clearWatch(wakeState.watchId);
  clearInterval(wakeState.repeatTimer);
  if (wakeWakeLock) {
    wakeWakeLock.release().catch(() => {});
    wakeWakeLock = null;
  }
  if (wakeState.btnEl) {
    wakeState.btnEl.textContent = '🔔 Wake me up';
    wakeState.btnEl.classList.remove('active');
  }
  if (wakeState.statusEl) wakeState.statusEl.textContent = '';
  els.wakeAlert.classList.add('hidden');
  if (showMsg) showToast('Wake-up alert cancelled.');
  wakeState = null;
}

els.wakeAlertDismiss.addEventListener('click', () => stopWakeAlert(false));

// ---------- Live bus arrivals (LTA DataMall, via /api/bus-arrivals) ----------
// Shows every bus service due at a stop, not just the one in the itinerary —
// useful for spotting an earlier bus on a different service that also works.

const ARRIVALS_REFRESH_MS = 20000;

// Arrivals panels can live in more than one place at once (a directions step,
// a Favourites row) — each panel tracks its own refresh interval on itself
// (panel._refreshInterval), and this sweeps just the ones inside a given
// container right before that container's contents get torn down/rebuilt.
function clearArrivalIntervalsIn(container) {
  container.querySelectorAll('.arrivals-panel').forEach((panel) => {
    if (panel._refreshInterval) clearInterval(panel._refreshInterval);
    if (panel._tickInterval) clearInterval(panel._tickInterval);
  });
}

function formatArrivalMins(iso) {
  if (!iso) return null;
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  return mins <= 0 ? 'Arr' : `${mins} min`;
}

// LTA's Load field on each bus: SEA = seats available, SDA = standing
// available (no seats but comfortable), LSD = limited standing (packed).
const LOAD_LABELS = { SEA: 'Seats available', SDA: 'Standing available', LSD: 'Limited standing — packed' };
function loadClass(load) {
  return load && LOAD_LABELS[load] ? `load-${load.toLowerCase()}` : 'load-unknown';
}
function loadLabel(load) {
  return LOAD_LABELS[load] || 'Crowding unknown';
}

// "Xs ago" / "Xm ago" label so it's always clear how fresh the data on
// screen actually is, rather than silently trusting a stale fetch.
function formatAgo(fetchedAtMs) {
  const secs = Math.max(0, Math.round((Date.now() - fetchedAtMs) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

function updateArrivalsMeta(panel) {
  const el = panel.querySelector('.arrivals-updated');
  if (el && panel._fetchedAt) el.textContent = formatAgo(panel._fetchedAt);
}

async function fetchAndRenderArrivals(busStopCode, panel) {
  try {
    const res = await fetch(`/api/bus-arrivals?busStopCode=${encodeURIComponent(busStopCode)}`);
    const data = await res.json();

    if (!res.ok) {
      panel.innerHTML = `<div class="arrivals-error">${data.error || 'Live arrivals unavailable.'}</div>`;
      return;
    }

    if (!data.services || !data.services.length) {
      panel.innerHTML = `<div class="arrivals-error">No live data for this stop right now.</div>`;
      return;
    }

    panel._fetchedAt = data.fetchedAt ? new Date(data.fetchedAt).getTime() : Date.now();

    panel.innerHTML = '';
    const meta = document.createElement('div');
    meta.className = 'arrivals-meta';
    meta.innerHTML = '<span class="arrivals-live-dot">●</span> Live · updated <span class="arrivals-updated">just now</span>';
    panel.appendChild(meta);

    const legend = document.createElement('div');
    legend.className = 'arrivals-legend';
    legend.innerHTML =
      '<span class="load-dot load-sea"></span>Seats' +
      '<span class="load-dot load-sda"></span>Standing' +
      '<span class="load-dot load-lsd"></span>Packed';
    panel.appendChild(legend);

    data.services.forEach((svc) => {
      const row = document.createElement('div');
      row.className = 'arrival-row';
      const num = document.createElement('span');
      num.className = 'arrival-service';
      num.textContent = svc.serviceNo;
      const times = document.createElement('span');
      times.className = 'arrival-times';

      const validArrivals = svc.nextArrivals.filter((a) => formatArrivalMins(a.estimatedArrival));
      if (!validArrivals.length) {
        times.textContent = 'No estimate';
      } else {
        validArrivals.forEach((a) => {
          const chip = document.createElement('span');
          chip.className = 'arrival-chip';
          const titleParts = [loadLabel(a.load)];

          const label = document.createElement('span');
          label.textContent = formatArrivalMins(a.estimatedArrival);
          chip.appendChild(label);

          if (a.type === 'DD') {
            const badge = document.createElement('span');
            badge.className = 'bus-badge';
            badge.textContent = 'DD';
            chip.appendChild(badge);
            titleParts.push('Double-deck bus');
          } else if (a.type === 'BD') {
            const badge = document.createElement('span');
            badge.className = 'bus-badge';
            badge.textContent = 'BD';
            chip.appendChild(badge);
            titleParts.push('Bendy bus');
          }

          if (a.wheelchairAccessible) {
            const wc = document.createElement('span');
            wc.className = 'bus-badge wc-badge';
            wc.textContent = '♿';
            chip.appendChild(wc);
            titleParts.push('Wheelchair accessible');
          }

          const dot = document.createElement('span');
          dot.className = `load-dot ${loadClass(a.load)}`;
          chip.appendChild(dot);

          chip.title = titleParts.join(' · ');
          times.appendChild(chip);
        });
      }

      row.appendChild(num);
      row.appendChild(times);
      panel.appendChild(row);
    });

    updateArrivalsMeta(panel);
  } catch (err) {
    console.error(err);
    panel.innerHTML = `<div class="arrivals-error">Could not load live arrivals.</div>`;
  }
}

function toggleArrivalsPanel(busStopCode, btnEl, panel) {
  const isOpen = !panel.classList.contains('hidden');
  if (isOpen) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    if (panel._refreshInterval) {
      clearInterval(panel._refreshInterval);
      panel._refreshInterval = null;
    }
    if (panel._tickInterval) {
      clearInterval(panel._tickInterval);
      panel._tickInterval = null;
    }
    btnEl.textContent = '🚌 Live arrivals';
    btnEl.classList.remove('active');
    return;
  }

  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="arrivals-error">Loading…</div>';
  btnEl.textContent = '🚌 Hide arrivals';
  btnEl.classList.add('active');
  fetchAndRenderArrivals(busStopCode, panel);
  panel._refreshInterval = setInterval(() => fetchAndRenderArrivals(busStopCode, panel), ARRIVALS_REFRESH_MS);
  panel._tickInterval = setInterval(() => updateArrivalsMeta(panel), 1000);
}

// ---------- Favourites — saved bus stops with live arrivals on demand ----------
// Stored locally in this browser (not synced anywhere); reuses the same
// arrivals panel machinery as the directions steps above.

const FAVOURITES_KEY = 'waypoint_favourites';

function loadFavourites() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVOURITES_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

let favourites = loadFavourites(); // [{ code, name }]

function saveFavourites() {
  try {
    localStorage.setItem(FAVOURITES_KEY, JSON.stringify(favourites));
  } catch (err) {
    console.error(err);
  }
}

function isFavourite(code) {
  return favourites.some((f) => f.code === code);
}

function toggleFavourite(stop) {
  if (isFavourite(stop.code)) {
    favourites = favourites.filter((f) => f.code !== stop.code);
    showToast(`Removed ${stop.name || stop.code} from Favourites.`);
  } else {
    favourites.push({ code: stop.code, name: stop.name || stop.code });
    showToast(`Added ${stop.name || stop.code} to Favourites.`);
  }
  saveFavourites();
  renderFavourites();
}

function renderFavourites() {
  clearArrivalIntervalsIn(els.favList);
  els.favList.innerHTML = '';
  els.favEmptyHint.classList.toggle('hidden', favourites.length > 0);

  favourites.forEach((fav) => {
    const li = document.createElement('li');
    li.className = 'fav-item';

    const headerRow = document.createElement('div');
    headerRow.className = 'fav-header-row';

    const label = document.createElement('span');
    label.className = 'fav-label';
    label.innerHTML = `<strong>${fav.name}</strong> <span class="fav-code">(${fav.code})</span>`;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'fav-remove-btn';
    removeBtn.title = 'Remove from Favourites';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => toggleFavourite(fav));

    headerRow.appendChild(label);
    headerRow.appendChild(removeBtn);

    const arrivalsBtn = document.createElement('button');
    arrivalsBtn.type = 'button';
    arrivalsBtn.className = 'arrivals-btn';
    arrivalsBtn.textContent = '🚌 Live arrivals';

    const panel = document.createElement('div');
    panel.className = 'arrivals-panel hidden';

    arrivalsBtn.addEventListener('click', () => toggleArrivalsPanel(fav.code, arrivalsBtn, panel));

    li.appendChild(headerRow);
    li.appendChild(arrivalsBtn);
    li.appendChild(panel);
    els.favList.appendChild(li);
  });
}

function renderStopSearchResults(results) {
  els.favSearchResults.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'r-title';
    title.textContent = `${r.name} (${r.code})`;
    const sub = document.createElement('span');
    sub.className = 'r-sub';
    const subParts = [];
    if (r.distance != null) subParts.push(`${formatDistance(r.distance)} away`);
    if (r.road) subParts.push(r.road);
    sub.textContent = subParts.join(' · ');
    li.appendChild(title);
    li.appendChild(sub);
    li.addEventListener('click', () => {
      if (isFavourite(r.code)) {
        showToast(`${r.name} is already in your Favourites.`);
      } else {
        favourites.push({ code: r.code, name: r.name });
        saveFavourites();
        renderFavourites();
        showToast(`Added ${r.name} to Favourites.`);
      }
      els.favSearchInput.value = '';
      els.favSearchResults.innerHTML = '';
    });
    els.favSearchResults.appendChild(li);
  });
}

const runStopSearch = debounce(async (q) => {
  try {
    const res = await fetch(`/api/stop-search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) {
      els.favSearchResults.innerHTML = `<li class="r-sub">${data.error || 'Search unavailable.'}</li>`;
      return;
    }
    renderStopSearchResults(data.results || []);
  } catch (err) {
    console.error(err);
    els.favSearchResults.innerHTML = '<li class="r-sub">Could not search bus stops.</li>';
  }
}, 350);

els.nearbyStopsBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    showToast('Geolocation is not supported by your browser.');
    return;
  }
  const originalText = els.nearbyStopsBtn.textContent;
  els.nearbyStopsBtn.disabled = true;
  els.nearbyStopsBtn.textContent = 'Locating…';

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        const res = await fetch(`/api/stop-search-nearby?lat=${latitude}&lon=${longitude}`);
        const data = await res.json();
        if (!res.ok) {
          els.favSearchResults.innerHTML = `<li class="r-sub">${data.error || 'Search unavailable.'}</li>`;
          return;
        }
        els.favSearchInput.value = '';
        renderStopSearchResults(data.results || []);
      } catch (err) {
        console.error(err);
        els.favSearchResults.innerHTML = '<li class="r-sub">Could not find nearby stops.</li>';
      } finally {
        els.nearbyStopsBtn.disabled = false;
        els.nearbyStopsBtn.textContent = originalText;
      }
    },
    (err) => {
      console.error('nearby-stops geolocation error:', err);
      showToast(geoErrorMessage(err));
      els.nearbyStopsBtn.disabled = false;
      els.nearbyStopsBtn.textContent = originalText;
    },
    GEO_OPTIONS
  );
});

els.favSearchInput.addEventListener('input', (e) => {
  const v = e.target.value.trim();
  if (v.length < 1) { els.favSearchResults.innerHTML = ''; return; }
  runStopSearch(v);
});

document.addEventListener('click', (e) => {
  if (!els.favSearchInput.contains(e.target) && !els.favSearchResults.contains(e.target)) {
    els.favSearchResults.innerHTML = '';
  }
});

renderFavourites();
updateQuickButtons();

// ---------- Geolocation ----------

els.locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    showToast('Geolocation is not supported by your browser.');
    return;
  }
  els.locateBtnIcon.textContent = '…';
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`;
        const res = await fetch(url);
        const data = await res.json();
        const displayName = data?.display_name || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        currentPlace = { lat: latitude, lon: longitude, display_name: displayName };
        els.placeName.textContent = shortLabel({ display_name: displayName });
        els.placeAddress.textContent = displayName;
        els.placeCard.classList.remove('hidden');
        document.querySelector('.tab-btn[data-tab="search"]').click();
      } catch (err) {
        console.error(err);
        showToast('Could not determine your address.');
      } finally {
        els.locateBtnIcon.textContent = '🎯';
      }
    },
    (err) => {
      console.error('locate-me geolocation error:', err);
      showToast(geoErrorMessage(err));
      els.locateBtnIcon.textContent = '🎯';
    },
    GEO_OPTIONS
  );
});

// ---------- Share ----------

els.shareBtn.addEventListener('click', async () => {
  const shareData = {
    title: 'Waypoint',
    text: 'Waypoint — a clean, ad-free maps & directions app for Singapore.',
    url: location.origin,
  };

  if (navigator.share) {
    try {
      await navigator.share(shareData);
    } catch (err) {
      if (err.name !== 'AbortError') console.error(err);
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(shareData.url);
    showToast('Link copied — share it with a friend!');
  } catch (err) {
    console.error(err);
    showToast(shareData.url, 5000);
  }
});

// ---------- Offline support ----------
// Registers the service worker (public/sw.js) so the app shell loads
// instantly with no signal, and shows a banner while offline. Search,
// routing, and live bus/weather/carpark data still need a connection —
// this only covers the app shell + whatever a browser cache can hold.

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}

function updateOfflineBanner() {
  if (!els.offlineBanner) return;
  els.offlineBanner.classList.toggle('hidden', navigator.onLine);
}

window.addEventListener('online', () => {
  updateOfflineBanner();
  showToast('✅ Back online.');
});
window.addEventListener('offline', () => {
  updateOfflineBanner();
  showToast("📡 You're offline — saved places still work, but search/routing/live data need a connection.", 4000);
});
updateOfflineBanner();

// ---------- Push notifications (MRT/LRT disruptions + major traffic incidents) ----------
// One combined on/off toggle (the 🔔 button in the topbar) rather than
// separate switches — simpler for a first version. Subscribing asks the
// browser/OS for notification permission, then registers a Push subscription
// with our server, which sends a notification the moment it detects a new
// MRT/LRT disruption or a serious traffic incident (see server.js) — even if
// Waypoint isn't open.

const PUSH_ENABLED_KEY = 'waypoint_push_enabled';

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Web Push wants the VAPID public key as a Uint8Array, but the server hands
// it over as a URL-safe base64 string — this is the standard conversion.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function updateNotifyButton() {
  if (!els.notifyBtn) return;
  const enabled = localStorage.getItem(PUSH_ENABLED_KEY) === '1';
  els.notifyBtn.classList.toggle('active', enabled);
  els.notifyBtn.title = enabled ? 'Train/traffic alerts are ON — tap to turn off' : 'Turn on train/traffic alerts';
}

async function enablePushAlerts() {
  if (!pushSupported()) {
    showToast("Push notifications aren't supported in this browser.");
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Notification permission was not granted — you can allow it later in your browser/app settings.');
      return;
    }
    const { publicKey, enabled } = await (await fetch('/api/push/vapid-public-key')).json();
    if (!enabled || !publicKey) {
      showToast("Alerts aren't set up on the server yet — try again later.");
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub }),
    });
    localStorage.setItem(PUSH_ENABLED_KEY, '1');
    updateNotifyButton();
    showToast("🔔 Alerts enabled — you'll get a notification for MRT/LRT disruptions and major traffic incidents.", 4000);
  } catch (err) {
    console.error(err);
    const detail = err && (err.message || err.name) ? `: ${err.name || ''} ${err.message || ''}`.trim() : '';
    showToast(`Could not enable notifications${detail}.`, 6000);
  }
}

async function disablePushAlerts() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
  } catch (err) {
    console.error(err);
  }
  localStorage.removeItem(PUSH_ENABLED_KEY);
  updateNotifyButton();
  showToast('Alerts turned off.');
}

if (els.notifyBtn) {
  els.notifyBtn.addEventListener('click', () => {
    const enabled = localStorage.getItem(PUSH_ENABLED_KEY) === '1';
    if (enabled) disablePushAlerts();
    else enablePushAlerts();
  });
}
updateNotifyButton();

// ---------- PWA install banner ----------
// Chrome/Edge (Android + desktop) fire "beforeinstallprompt" when the app
// qualifies for install (has a manifest + icons, which we already set up).
// iOS Safari never fires this event — there's no equivalent prompt to hook.

const INSTALL_DISMISS_KEY = 'waypoint_install_dismissed_at';
const INSTALL_DISMISS_DAYS = 14; // don't nag again for a couple weeks after "Not now"

let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function installDismissedRecently() {
  const raw = localStorage.getItem(INSTALL_DISMISS_KEY);
  if (!raw) return false;
  const daysSince = (Date.now() - parseInt(raw, 10)) / (1000 * 60 * 60 * 24);
  return daysSince < INSTALL_DISMISS_DAYS;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  if (isStandalone() || installDismissedRecently()) return;
  deferredInstallPrompt = e;
  els.installBanner.classList.remove('hidden');
});

els.installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  els.installBanner.classList.add('hidden');
  deferredInstallPrompt.prompt();
  try {
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome !== 'accepted') {
      localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
    }
  } catch (err) {
    console.error(err);
  }
  deferredInstallPrompt = null;
});

els.installDismissBtn.addEventListener('click', () => {
  els.installBanner.classList.add('hidden');
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  deferredInstallPrompt = null;
});

window.addEventListener('appinstalled', () => {
  els.installBanner.classList.add('hidden');
  deferredInstallPrompt = null;
});

// ---------- Current weather widget (topbar) ----------
// Ambient conditions indicator (e.g. "☀️ Fair") next to the locate button —
// reuses the same NEA-backed /api/weather-nearby endpoint that powers rain
// alerts. Geolocates silently on load (no error toast; this isn't something
// the user asked for, just a nice-to-have), falling back to a central
// Singapore point if location isn't available so it still shows something.

const SG_CENTER = { lat: 1.3521, lon: 103.8198 };
const WEATHER_WIDGET_REFRESH_MS = 10 * 60 * 1000;
let weatherWidgetTimer = null;

async function loadWeatherWidget(coords) {
  try {
    const res = await fetch(`/api/weather-nearby?lat=${coords.lat}&lon=${coords.lon}`);
    const data = await res.json();
    if (!res.ok || !data.forecast) {
      els.weatherWidget.classList.add('hidden');
      return;
    }
    els.weatherWidget.textContent = `${data.icon || '🌤️'} ${data.forecast}`;
    els.weatherWidget.title = `${data.forecast} near ${data.area} — tap for details`;
    els.weatherWidget.dataset.area = data.area;
    els.weatherWidget.dataset.forecast = data.forecast;
    els.weatherWidget.classList.remove('hidden');
  } catch (err) {
    console.error('weather widget failed:', err);
    els.weatherWidget.classList.add('hidden');
  }
}

function initWeatherWidget() {
  const refresh = (coords) => {
    loadWeatherWidget(coords);
    clearInterval(weatherWidgetTimer);
    weatherWidgetTimer = setInterval(() => loadWeatherWidget(coords), WEATHER_WIDGET_REFRESH_MS);
  };

  if (!navigator.geolocation) {
    refresh(SG_CENTER);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => refresh({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
    () => refresh(SG_CENTER), // silent fallback — ambient widget, not a user-initiated action
    GEO_OPTIONS
  );
}

// ---------- Today's detailed weather panel ----------
// Tapping the widget opens a fuller outlook (temperature/humidity/wind range
// for today, via NEA's 24-hour forecast) alongside the hyper-local 2-hour
// condition the widget itself already shows.

function renderWeatherPanel(daily) {
  const area = els.weatherWidget.dataset.area;
  const nowForecast = els.weatherWidget.dataset.forecast;
  const nowLine = area && nowForecast
    ? `<p class="weather-panel-now">📍 Right now near <strong>${area}</strong>: ${nowForecast}</p>`
    : '';
  const temp = daily.tempLow != null && daily.tempHigh != null ? `${daily.tempLow}–${daily.tempHigh}°C` : '—';
  const humidity = daily.humidityLow != null && daily.humidityHigh != null ? `${daily.humidityLow}–${daily.humidityHigh}%` : '—';
  const wind = daily.windSpeedLow != null && daily.windSpeedHigh != null
    ? `${daily.windDirection || ''} ${daily.windSpeedLow}–${daily.windSpeedHigh} km/h`.trim()
    : '—';

  els.weatherPanelBody.innerHTML = `
    <div class="weather-panel-icon">${daily.icon || '🌤️'}</div>
    <h3 class="weather-panel-headline">${daily.forecast || "Today's outlook"}</h3>
    ${nowLine}
    <div class="weather-panel-grid">
      <div><span class="weather-panel-label">Temperature</span><span class="weather-panel-value">${temp}</span></div>
      <div><span class="weather-panel-label">Humidity</span><span class="weather-panel-value">${humidity}</span></div>
      <div><span class="weather-panel-label">Wind</span><span class="weather-panel-value">${wind}</span></div>
    </div>
    <p class="weather-panel-note">Today's outlook, Singapore-wide — via NEA.</p>
  `;
}

async function openWeatherPanel() {
  els.weatherPanel.classList.remove('hidden');
  els.weatherPanelBody.innerHTML = '<div class="weather-panel-loading">Loading…</div>';
  try {
    const res = await fetch('/api/weather-today');
    const data = await res.json();
    if (!res.ok) {
      els.weatherPanelBody.innerHTML = `<div class="weather-panel-loading">${data.error || 'Could not load forecast.'}</div>`;
      return;
    }
    renderWeatherPanel(data);
  } catch (err) {
    console.error('weather panel failed:', err);
    els.weatherPanelBody.innerHTML = '<div class="weather-panel-loading">Could not load forecast.</div>';
  }
}

els.weatherWidget.addEventListener('click', openWeatherPanel);
els.weatherPanelClose.addEventListener('click', () => els.weatherPanel.classList.add('hidden'));
els.weatherPanel.addEventListener('click', (e) => {
  if (e.target === els.weatherPanel) els.weatherPanel.classList.add('hidden');
});

initWeatherWidget();

// ---------- MRT/LRT service disruption banner (LTA TrainServiceAlerts) ----------
// Polls a cached server endpoint every couple of minutes. Dismissing a
// specific alert hides it for the rest of this browser session; a genuinely
// new disruption message (different text) will still show even if an older
// one was dismissed.

const TRAIN_ALERTS_POLL_MS = 2 * 60 * 1000;
let currentTrainAlertMessage = null;
let dismissedTrainAlertMessage = null;

async function checkTrainAlerts() {
  try {
    const res = await fetch('/api/train-alerts');
    const data = await res.json();

    if (!data.disrupted || !data.message) {
      currentTrainAlertMessage = null;
      els.trainAlertBanner.classList.add('hidden');
      return;
    }

    currentTrainAlertMessage = data.message;
    if (currentTrainAlertMessage === dismissedTrainAlertMessage) return;

    const linesPrefix = data.lines && data.lines.length ? `${data.lines.join(', ')}: ` : '';
    els.trainAlertText.textContent = `${linesPrefix}${data.message}`;
    els.trainAlertBanner.classList.remove('hidden');
  } catch (err) {
    console.error('train alerts check failed:', err);
  }
}

els.trainAlertDismiss.addEventListener('click', () => {
  dismissedTrainAlertMessage = currentTrainAlertMessage;
  els.trainAlertBanner.classList.add('hidden');
});

checkTrainAlerts();
setInterval(checkTrainAlerts, TRAIN_ALERTS_POLL_MS);

// ---------- Incoming destination via URL (deep link from other apps) ----------
// Lets an external tool send you straight into a ready route:
//   ?dest_lat=1.311&dest_lon=103.845&dest_label=Mount%20Elizabeth%20Hospital
(function handleIncomingDestination() {
  const params = new URLSearchParams(window.location.search);
  const destLat = parseFloat(params.get('dest_lat'));
  const destLon = parseFloat(params.get('dest_lon'));
  const destLabel = params.get('dest_label');
  if (!destLabel || Number.isNaN(destLat) || Number.isNaN(destLon)) return;

  setTo({ lat: destLat, lon: destLon, label: destLabel, address: destLabel });
  switchToDirectionsTab();

  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setFrom({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Your location' });
      if (fromCoords && toCoords) getDirections();
    },
    (err) => {
      console.error('incoming-destination geolocation error:', err);
      showToast(geoErrorMessage(err) + ' — pick a starting point to get directions.');
    },
    GEO_OPTIONS
  );
})();

// ---------- Buy Melvin a coffee — PayNow QR popup ----------
// Shows once per visitor (localStorage flag), after a short delay so it
// never blocks the page. Skipped entirely if the page was opened via a
// destination deep link (e.g. from the appointment check-in app) — someone
// mid-errand to an appointment shouldn't get a donation popup.
(function paynowCoffeePopup() {
  const MOBILE = '+6581617181';
  const AMOUNT = 1.00;
  const MERCHANT_NAME = 'Melvin';
  const MERCHANT_CITY = 'Singapore';
  const STORAGE_KEY = 'paynow_coffee_popup_shown_v1';

  const incomingParams = new URLSearchParams(window.location.search);
  if (incomingParams.has('dest_lat')) return;
  if (localStorage.getItem(STORAGE_KEY)) return;

  function crc16ccitt(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= (str.charCodeAt(i) << 8);
      for (let j = 0; j < 8; j++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  function tlv(tag, value) {
    return `${tag}${String(value.length).padStart(2, '0')}${value}`;
  }

  function buildPayNowPayload() {
    const payNowInfo =
      tlv('00', 'SG.PAYNOW') +
      tlv('01', '0') +        // proxy type: 0 = mobile number
      tlv('02', MOBILE) +
      tlv('03', '0');          // amount not editable (fixed)

    let payload =
      tlv('00', '01') +
      tlv('01', '12') +        // dynamic (carries a fixed amount)
      tlv('26', payNowInfo) +
      tlv('52', '0000') +
      tlv('53', '702') +       // SGD
      tlv('54', AMOUNT.toFixed(2)) +
      tlv('58', 'SG') +
      tlv('59', MERCHANT_NAME.slice(0, 25)) +
      tlv('60', MERCHANT_CITY);

    payload += '6304';
    payload += crc16ccitt(payload);
    return payload;
  }

  function showPopup() {
    const payload = buildPayNowPayload();
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=${encodeURIComponent(payload)}`;

    const style = document.createElement('style');
    style.textContent = `
      .coffee-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 20px; }
      .coffee-card { background: #fff; border-radius: 14px; padding: 24px 22px; max-width: 320px; width: 100%; text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,0.25); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .coffee-card h3 { margin: 4px 0 6px; font-size: 18px; }
      .coffee-card p { margin: 0 0 14px; font-size: 13.5px; color: #555; }
      .coffee-card img { width: 100%; max-width: 220px; border-radius: 8px; margin-bottom: 14px; }
      .coffee-close { background: #111; color: #fff; border: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; cursor: pointer; }
      .coffee-dismiss { display: block; margin: 10px auto 0; background: none; border: none; color: #888; font-size: 12.5px; cursor: pointer; text-decoration: underline; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'coffee-overlay';
    overlay.innerHTML = `
      <div class="coffee-card">
        <h3>☕ Buy Melvin a coffee?</h3>
        <p>If Waypoint's been useful, scan to send $1 via PayNow — totally optional!</p>
        <img src="${qrUrl}" alt="PayNow QR code">
        <button class="coffee-close">Close</button>
        <button class="coffee-dismiss">Don't show this again</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.coffee-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.coffee-dismiss').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  localStorage.setItem(STORAGE_KEY, '1');
  setTimeout(showPopup, 2500);
})();
