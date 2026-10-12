// Booking / information links for a journey.

const pad = (n) => String(n).padStart(2, '0');

/**
 * National Rail journey planner deep link (best effort; the site may change
 * its URL scheme). date: 'YYYY-MM-DD', minutes: minutes after midnight.
 */
export function nationalRailUrl(fromCrs, toCrs, date, minutes) {
  const [y, m, d] = date.split('-');
  const mins = ((minutes % 1440) + 1440) % 1440;
  const params = new URLSearchParams({
    type: 'single',
    origin: fromCrs,
    destination: toCrs,
    leavingType: 'departing',
    leavingDate: `${d}${m}${y.slice(2)}`,
    leavingHour: pad(Math.floor(mins / 60)),
    leavingMin: pad(mins % 60),
    adults: '1',
    extraTime: '0',
  });
  return `https://www.nationalrail.co.uk/journey-planner/?${params}#O`;
}

export function bookingLinks({ origin, destination, date, depMinutes, tickets, operators }) {
  const links = [];
  if (origin.crs && destination.crs) {
    links.push({
      label: 'Check times & fares on National Rail',
      url: nationalRailUrl(origin.crs, destination.crs, date, depMinutes),
      kind: 'journey',
    });
  }
  if (tickets && tickets.length > 1) {
    for (const t of tickets) {
      if (!t.fromCrs || !t.toCrs) continue;
      links.push({
        label: `Ticket ${t.fromName} → ${t.toName}`,
        url: nationalRailUrl(t.fromCrs, t.toCrs, t.date || date, t.depMinutes ?? depMinutes),
        kind: 'ticket',
      });
    }
  }
  for (const op of operators) {
    if (op.url) links.push({ label: `Buy from ${op.name}`, url: op.url, kind: 'operator' });
  }
  return links;
}
