// SnowHop site settings. Edit a value, then re-upload this file.
window.SNOWHOP = {
  apiUrl: "https://osngmlbiegemjfyavfap.supabase.co/functions/v1/snow-book",
  phone: "3039939110",
  ownerName: "Ethan",
  timezone: "America/Denver",
  // Spots left only show once a day is down to this many or fewer.
  showSpotsLeftAt: 5,
  // The Snow watch forecast and maps center here (Highlands Ranch). radarSite is the closest NWS radar (KFTG = Denver).
  weather: { lat: 39.5437, lon: -104.9691, place: "Highlands Ranch", radarSite: "KFTG" },
  // Demo mode: the site runs as a KarooHops demo, so nothing is booked, charged or sent. Set to false to take real bookings again.
  demo: true,
};
