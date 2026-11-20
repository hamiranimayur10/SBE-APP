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

  function isTournamentReadyToComplete(tournament) {
    if (!tournament || tournament.phase !== 'finals') return false;
    const qr1 = tournament.qr1Matches || [];
    if (!qr1.length || qr1.some(match => !match.completed)) return false;
    const pools = Object.keys(tournament.qr2Pools || {}).filter(key => (tournament.qr2Pools[key] || []).length);
    if (!pools.length) return false;
    if (pools.some(key =>
      !(tournament.qr2Matches?.[key] || []).length ||
      (tournament.semis?.[key] || []).length < 2 ||
      !tournament.finals?.[key]?.completed
    )) return false;
    return [
      ...Object.values(tournament.qr2Matches || {}).flat(),
      ...Object.values(tournament.semis || {}).flat(),
      ...Object.values(tournament.finals || {}).filter(Boolean)
    ].every(match => match.completed);
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

  function validateGroupMatchCount(playerCount, matchesPerPlayer) {
    if (!Number.isInteger(matchesPerPlayer) || matchesPerPlayer < 1) {
      throw new RangeError('Matches per player must be a positive whole number');
    }
    if (!Number.isInteger(playerCount) || playerCount < 4) {
      throw new RangeError('Doubles groups need at least 4 players');
    }
    if (matchesPerPlayer >= playerCount) {
      throw new RangeError('Matches per player must be less than the group size to avoid repeated partners');
    }
    if ((playerCount * matchesPerPlayer) % 4 !== 0) {
      throw new RangeError('Players multiplied by matches per player must be divisible by 4 for doubles');
    }
  }

  function validateGroupPlayers(players, matchesPerPlayer) {
    if (!Array.isArray(players)) throw new TypeError('Players must be a list');
    validateGroupMatchCount(players.length, matchesPerPlayer);
    const names = players.map(normalizePlayerName);
    if (names.some(name => !name) || new Set(names).size !== names.length) {
      throw new RangeError('Each player in the group must have a distinct name');
    }
    if (players.some(name => String(name).includes('&'))) {
      throw new RangeError('Player names cannot contain & in doubles schedules');
    }
  }

  function generateGroupPairings(players, matchesPerPlayer, random = Math.random) {
    validateGroupPlayers(players, matchesPerPlayer);
    const shuffled = [...players];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    const partnerships = [];
    for (let distance = 1; distance <= Math.floor(matchesPerPlayer / 2); distance++) {
      for (let index = 0; index < players.length; index++) {
        partnerships.push([index, (index + distance) % players.length]);
      }
    }
    if (matchesPerPlayer % 2) {
      for (let index = 0; index < players.length / 2; index++) {
        partnerships.push([index, index + players.length / 2]);
      }
    }
    const disjoint = (a, b) => !a.some(player => b.includes(player));
    const matches = [];
    while (partnerships.length) {
      const first = partnerships.pop();
      const opponentIndex = partnerships.findIndex(team => disjoint(first, team));
      if (opponentIndex !== -1) {
        matches.push([first, partnerships.splice(opponentIndex, 1)[0]]);
        continue;
      }

      // Reassign a previous match when the remaining partnerships overlap.
      let repaired = false;
      for (let index = 0; index < partnerships.length && !repaired; index++) {
        const second = partnerships[index];
        for (let previous = 0; previous < matches.length; previous++) {
          let [a, b] = matches[previous];
          if (!disjoint(first, a) || !disjoint(second, b)) [a, b] = [b, a];
          if (!disjoint(first, a) || !disjoint(second, b)) continue;
          matches[previous] = [first, a];
          matches.push([second, b]);
          partnerships.splice(index, 1);
          repaired = true;
          break;
        }
      }
      if (!repaired) throw new RangeError('Could not generate a schedule with unique partners for this group');
    }
    return matches.map(match => match.map(team => team.map(index => shuffled[index])));
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

  function generateGroupSchedule(players, matchesPerPlayer, groupId, roundPrefix) {
    const matches = generateGroupPairings(players, matchesPerPlayer).map((pair, index) => ({
      id: `${roundPrefix}-${groupId}-${index + 1}`,
      groupId,
      p1: pair[0].join(' & '),
      p2: pair[1].join(' & '),
      s1: null,
      s2: null,
      completed: false
    }));
    return scheduleMatchesForCourts(matches, 2);
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

  return { drawSemiFinalPartners, generateGroupPairings, generateGroupSchedule, groupRankedPlayers, isTournamentReadyToComplete, scheduleMatchesForCourts, validateGroupMatchCount, validateGroupPlayers };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TournamentDraw;
if (typeof window !== 'undefined') window.TournamentDraw = TournamentDraw;
