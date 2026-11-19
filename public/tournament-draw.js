'use strict';

const TournamentDraw = (() => {
  function groupRankedPlayers(players, groupCount) {
    if (!Array.isArray(players) || players.length === 0) {
      throw new RangeError('Ranked groups require at least one player');
    }
    if (!Number.isInteger(groupCount) || groupCount < 1 || groupCount > 6 || groupCount > players.length) {
      throw new RangeError('Group count must be between one and six and cannot exceed the player count');
    }

    const groups = {};
    const baseSize = Math.floor(players.length / groupCount);
    const remainder = players.length % groupCount;
    let offset = 0;
    for (let index = 0; index < groupCount; index++) {
      const size = baseSize + (index < remainder ? 1 : 0);
      groups[String.fromCharCode(65 + index)] = players.slice(offset, offset + size);
      offset += size;
    }
    return groups;
  }

  function normalizePlayerName(name) {
    return String(name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase();
  }

  function getMatchPlayers(match) {
    return [match.p1 || match.t1, match.p2 || match.t2]
      .flatMap(side => String(side || '').split(/\s*&\s*/))
      .map(normalizePlayerName)
      .filter(Boolean);
  }

  function scheduleMatchesForCourts(matches, courtCount = 2) {
    if (!Array.isArray(matches)) throw new TypeError('Matches must be a list');
    if (!Number.isInteger(courtCount) || courtCount < 1) throw new RangeError('Court count must be a positive integer');

    const remaining = [...matches];
    const scheduled = [];
    let round = 1;
    while (remaining.length) {
      const usedPlayers = new Set();
      const currentRound = [];
      const currentMatches = [];
      let pairFound = false;
      if (courtCount > 1) {
        for (let first = 0; first < remaining.length && !pairFound; first++) {
          const firstPlayers = new Set(getMatchPlayers(remaining[first]));
          for (let second = first + 1; second < remaining.length; second++) {
            if (getMatchPlayers(remaining[second]).some(player => firstPlayers.has(player))) continue;
            currentMatches.push(remaining[first], remaining[second]);
            remaining.splice(second, 1);
            remaining.splice(first, 1);
            pairFound = true;
            break;
          }
        }
      }
      if (!pairFound) currentMatches.push(remaining.shift());
      currentMatches.forEach(match => getMatchPlayers(match).forEach(player => usedPlayers.add(player)));
      currentRound.push(...currentMatches.map((match, index) => ({ ...match, round, court: index + 1 })));

      for (let index = 0; index < remaining.length && currentRound.length < courtCount;) {
        const match = remaining[index];
        const players = getMatchPlayers(match);
        if (players.some(player => usedPlayers.has(player))) {
          index++;
          continue;
        }
        players.forEach(player => usedPlayers.add(player));
        currentRound.push({ ...match, round, court: currentRound.length + 1 });
        remaining.splice(index, 1);
      }
      if (!currentRound.length) throw new Error('Could not schedule the remaining matches');
      scheduled.push(...currentRound);
      round++;
    }
    return scheduled;
  }

  function drawSemiFinalPartners(players, random = Math.random) {
    if (!Array.isArray(players) || players.length !== 8) {
      throw new RangeError('Semi-final partner draws require exactly eight players');
    }

    const topFour = players.slice(0, 4);
    const bottomFour = players.slice(4, 8);
    for (let index = bottomFour.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(random() * (index + 1));
      [bottomFour[index], bottomFour[swapIndex]] = [bottomFour[swapIndex], bottomFour[index]];
    }

    return topFour.map((player, index) => [player, bottomFour[index]]);
  }

  return { drawSemiFinalPartners, groupRankedPlayers, scheduleMatchesForCourts };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TournamentDraw;
if (typeof window !== 'undefined') window.TournamentDraw = TournamentDraw;
