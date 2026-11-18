const path = require('path');
const { zoneFacesForBracket } = require(path.resolve(process.cwd(), 'utils/playoffEditor'));
const { renderPlayoffBracket } = require(path.resolve(process.cwd(), 'utils/playoffBracket'));

// Test case:
// Team 1 is LOCKED at 1st place
// Team 2 is in ZONE at 4th place (clinched QF, not locked)
const team1 = {
  id: 101,
  name: 'Pardubice',
  liga: 'TELH',
  logo: 'pce.png',
  _clinchStatus: {
    currentZone: 'quarterfinal',
    locked: true, // LOCKED!
    clinchedQF: true,
    clinchedPlayin: true
  }
};

const team2 = {
  id: 102,
  name: 'Sparta',
  liga: 'TELH',
  logo: 'spa.png',
  _clinchStatus: {
    currentZone: 'quarterfinal',
    locked: false, // NOT LOCKED, BUT IN ZONE!
    clinchedQF: true,
    clinchedPlayin: true
  }
};

const template = {
  columns: [
    { title: 'Čtvrtfinále', slots: ['qf1'] }
  ],
  rules: {
    qf1: {
      home: { type: 'place', place: 1, group: '' },
      away: { type: 'place', place: 4, group: '' }
    }
  }
};

const teamsByGroup = {
  X: [team1, { id: 103, name: 'Brno', liga: 'TELH' }, { id: 104, name: 'Plzen', liga: 'TELH' }, team2]
};

const lockedIds = new Set([101]); // 101 is locked!

const faces = zoneFacesForBracket({
  template,
  savedSlots: {},
  teams: [team1, team2],
  teamsByGroup,
  tables: { TELH: { teamsByGroup, lockedIds } },
  leagueName: 'TELH',
  lockedIds,
  matches: []
});

console.log('zoneFaces result:', JSON.stringify(faces, null, 2));

const html = renderPlayoffBracket({
  template,
  savedSlots: {},
  matches: [],
  teams: [team1, team2],
  scores: {},
  zoneFaces: faces,
  selectedSeason: '26/27',
  selectedLiga: 'TELH',
  visible: true
});

console.log('HTML contains Pardubice:', html.includes('Pardubice'));
console.log('HTML contains Sparta:', html.includes('Sparta'));
console.log('HTML contains zatím čtvrtfinále:', html.includes('zatím čtvrtfinále'));
console.log('HTML snippet:\n', html.substring(html.indexOf('<article'), html.indexOf('</article>') + 10));
