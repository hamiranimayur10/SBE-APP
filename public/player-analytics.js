'use strict';

const PlayerAnalytics = (() => {
  const STAGE_ORDER = { qr1: 1, qr2: 2, semis: 3, finals: 4 };

  function normalizeName(name) {
    return String(name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase();
  }

  function getTeamPlayers(value) {
    return String(value || '')
      .split(/\s*&\s*/)
      .map(name => name.trim())
      .filter(name => name && !/^(TBD|Seed\s+\d+)$/i.test(name));
  }

  function accumulateStandings(players, matches) {
    const stats = Object.create(null);
    players.forEach(player => {
      stats[player] = {
        player, played: 0, wins: 0, losses: 0, pf: 0, pa: 0,
        winMargins: 0, lossMargins: 0, wp: 0, tiedFlag: false
      };
    });
    matches.forEach(match => {
      if (!match.completed || !validScore(match.s1) || !validScore(match.s2) || Number(match.s1) === Number(match.s2)) return;
      const sides = [getTeamPlayers(match.p1 || match.t1), getTeamPlayers(match.p2 || match.t2)];
      const participants = sides.flat();
      if (!sides[0].length || !sides[1].length ||
          new Set(participants).size !== participants.length ||
          participants.some(player => !stats[player])) return;
      sides.forEach((side, index) => {
        const own = Number(index === 0 ? match.s1 : match.s2);
        const other = Number(index === 0 ? match.s2 : match.s1);
        side.forEach(player => {
          const row = stats[player];
          row.played++;
          row.pf += own;
          row.pa += other;
          if (own > other) {
            row.wins++;
            row.winMargins += own - other;
          } else {
            row.losses++;
            row.lossMargins += other - own;
          }
        });
      });
    });
    return Object.values(stats);
  }

  function computeStandings(players, matches, ranking, wpFirst = false) {
    const stats = accumulateStandings(players, matches);
    const rk = ranking || { winPointsWeight: 20, winMarginWeight: 1, lossMarginWeight: 1, tiebreakers: ['wp', 'wins', 'pf', 'pa'] };
    const wPts = Number(rk.winPointsWeight ?? 20);
    const wWinM = Number(rk.winMarginWeight ?? 1);
    const wLossM = Number(rk.lossMarginWeight ?? 1);
    const configuredOrder = Array.isArray(rk.tiebreakers) && rk.tiebreakers.length ? rk.tiebreakers : ['wp', 'wins', 'pf', 'pa'];
    const order = wpFirst ? ['wp', ...configuredOrder.filter(key => key !== 'wp')] : configuredOrder;
    const rows = stats.map(row => ({
      ...row,
      diff: row.pf - row.pa,
      wp: row.wins * wPts + row.winMargins * wWinM - row.lossMargins * wLossM
    }));
    const metricVal = (row, key) => {
      if (key === 'wp') return row.wp;
      if (key === 'wins') return row.wins;
      if (key === 'pf') return row.pf;
      if (key === 'pa') return -row.pa;
      if (key === 'diff') return row.diff;
      return 0;
    };
    rows.sort((a, b) => {
      for (const key of order) {
        const diff = metricVal(b, key) - metricVal(a, key);
        if (diff !== 0) return diff;
      }
      return a.player.localeCompare(b.player);
    });
    for (let index = 0; index < rows.length - 1; index++) {
      const current = rows[index], next = rows[index + 1];
      if (current.played > 0 && order.every(key => metricVal(current, key) === metricVal(next, key))) {
        current.tiedFlag = true;
        next.tiedFlag = true;
      }
    }
    return rows;
  }

  function validScore(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  }

  function addMatches(records, tournament, stage, list, sequence) {
    (list || []).forEach((match, index) => {
      if (!match || !match.completed) return;

      const side1 = getTeamPlayers(match.p1 || match.t1);
      const side2 = getTeamPlayers(match.p2 || match.t2);
      if (!side1.length || !side2.length) return;

      let points1 = 0;
      let points2 = 0;
      let winnerSide = 0;
      let games = [];
      if (stage === 'finals' && Array.isArray(match.games)) {
        games = match.games.filter(game => game && validScore(game.s1) && validScore(game.s2));
        if (!games.length) return;
        points1 = games.reduce((sum, game) => sum + Number(game.s1), 0);
        points2 = games.reduce((sum, game) => sum + Number(game.s2), 0);
        const wins1 = games.filter(game => Number(game.s1) > Number(game.s2)).length;
        const wins2 = games.filter(game => Number(game.s2) > Number(game.s1)).length;
        if (wins1 !== wins2) winnerSide = wins1 > wins2 ? 1 : 2;
      } else {
        if (!validScore(match.s1) || !validScore(match.s2)) return;
        points1 = Number(match.s1);
        points2 = Number(match.s2);
        if (points1 !== points2) winnerSide = points1 > points2 ? 1 : 2;
      }

      if (!winnerSide && match.winner) {
        const winner = normalizeName(match.winner);
        if (winner === normalizeName(match.p1 || match.t1)) winnerSide = 1;
        if (winner === normalizeName(match.p2 || match.t2)) winnerSide = 2;
      }
      if (!winnerSide && points1 !== points2) winnerSide = points1 > points2 ? 1 : 2;
      if (!winnerSide) return;

      if (!games.length) games = [{ s1: points1, s2: points2 }];
      const timestamp = Date.parse(match.completedAt);
      const tournamentDate = tournament.data.config?.date || tournament.date || '';
      const dateTimestamp = Date.parse(`${tournamentDate}T00:00:00Z`);
      records.push({
        id: `${tournament.id}:${stage}:${match.id || index}`,
        tournamentId: String(tournament.id),
        tournamentName: tournament.data.config?.name || tournament.name || 'Tournament',
        tournamentDate,
        stage,
        groupId: match.groupId || '',
        side1,
        side2,
        points1,
        points2,
        gameScores: games.map(game => ({ s1: Number(game.s1), s2: Number(game.s2) })),
        winnerSide,
        completedAt: match.completedAt || '',
        timestamp: Number.isFinite(timestamp)
          ? timestamp
          : (Number.isFinite(dateTimestamp) ? dateTimestamp : 0) + STAGE_ORDER[stage] * 100000 + index,
        sequence: sequence.value++
      });
    });
  }

  function extractMatchRecords(tournaments) {
    const records = [];
    const sequence = { value: 0 };
    (tournaments || []).forEach(row => {
      const data = row && row.data && row.data.config ? row.data : row;
      if (!data || !data.config) return;
      const tournament = {
        id: String(data.tournamentId || row.id || row.tournamentId || 'default'),
        name: data.config.name || row.name,
        date: data.config.date || row.date,
        data
      };
      addMatches(records, tournament, 'qr1', data.qr1Matches, sequence);
      Object.values(data.qr2Matches || {}).forEach(matches => addMatches(records, tournament, 'qr2', matches, sequence));
      Object.values(data.semis || {}).forEach(matches => addMatches(records, tournament, 'semis', matches, sequence));
      Object.values(data.finals || {}).forEach(final => {
        if (final) addMatches(records, tournament, 'finals', [final], sequence);
      });
    });
    records.sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
    return records;
  }

  function rankingPoints(record, sideIndex, tournament) {
    const rules = tournament?.data?.config?.ranking || {};
    const winPoints = Number.isFinite(Number(rules.winPointsWeight)) ? Number(rules.winPointsWeight) : 20;
    const winMargin = Number.isFinite(Number(rules.winMarginWeight)) ? Number(rules.winMarginWeight) : 1;
    const lossMargin = Number.isFinite(Number(rules.lossMarginWeight)) ? Number(rules.lossMarginWeight) : 1;
    const isWinner = record.winnerSide === sideIndex;
    const margin = Math.abs(record.points1 - record.points2);
    return isWinner ? winPoints + margin * winMargin : -margin * lossMargin;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function buildAnalytics(tournaments, profileRows, currentTournamentId) {
    const tournamentList = tournaments || [];
    const profileList = Array.isArray(profileRows) ? profileRows : Object.values(profileRows || {});
    const canonicalNames = new Map();
    const profileByName = new Map();
    const profileById = new Map();
    const playerProfileIds = new Map();
    const ambiguousNames = new Set();
    const registerProfileName = (name, profile) => {
      const key = normalizeName(name);
      if (!key || ambiguousNames.has(key)) return;
      const existing = profileByName.get(key);
      if (existing && existing !== profile &&
        existing.playerId && profile.playerId && existing.playerId !== profile.playerId) {
        profileByName.delete(key);
        canonicalNames.delete(key);
        ambiguousNames.add(key);
        return;
      }
      profileByName.set(key, profile);
      canonicalNames.set(key, String(profile.name || '').trim());
    };
    profileList.forEach(profile => {
      const name = String(profile.name || '').trim();
      if (!normalizeName(name)) return;
      if (profile.playerId) profileById.set(String(profile.playerId), profile);
      [name, ...(Array.isArray(profile.aliases) ? profile.aliases : [])].forEach(alias => registerProfileName(alias, profile));
    });
    const tournamentDataById = new Map();
    tournamentList.forEach(row => {
      const data = row && row.data && row.data.config ? row.data : row;
      if (!data || !data.config) return;
      const id = String(data.tournamentId || row.id || row.tournamentId || 'default');
      tournamentDataById.set(id, data);
      Object.entries(data.playerProfileIds || {}).forEach(([name, playerId]) => {
        const key = normalizeName(name);
        if (!key || !playerId || ambiguousNames.has(key)) return;
        const existingId = playerProfileIds.get(key);
        if (existingId && existingId !== String(playerId)) {
          playerProfileIds.delete(key);
          ambiguousNames.add(key);
          return;
        }
        playerProfileIds.set(key, String(playerId));
      });
    });
    const profileForName = name => {
      const key = normalizeName(name);
      if (ambiguousNames.has(key)) return null;
      const linkedId = playerProfileIds.get(key);
      return (linkedId && profileById.get(linkedId)) || profileByName.get(key) ||
        (linkedId ? { name: String(name || '').trim(), playerId: linkedId } : null);
    };
    const resolveName = name => {
      const profile = profileForName(name);
      return profile?.name || canonicalNames.get(normalizeName(name)) || String(name || '').trim();
    };
    const records = extractMatchRecords(tournamentList).map(record => ({
      ...record,
      side1: record.side1.map(resolveName),
      side2: record.side2.map(resolveName),
      side1PlayerIds: record.side1.map(name => profileForName(name)?.playerId || ''),
      side2PlayerIds: record.side2.map(name => profileForName(name)?.playerId || '')
    }));
    const players = new Map();
    const tournamentById = new Map();

    tournamentList.forEach(row => {
      const data = row && row.data && row.data.config ? row.data : row;
      if (!data || !data.config) return;
      const id = String(data.tournamentId || row.id || row.tournamentId || 'default');
      tournamentById.set(id, { ...row, id, data });
      (data.groups || []).forEach(group => (group.players || []).forEach(name => ensurePlayer(resolveName(name))));
      Object.values(data.qr2Pools || {}).forEach(pool => (pool || []).forEach(name => ensurePlayer(resolveName(name))));
    });
    profileList.forEach(profile => ensurePlayer(resolveName(profile.name)));

    function ensurePlayer(name) {
      const displayName = String(name || '').trim();
      const key = normalizeName(displayName);
      if (!key) return null;
      if (!players.has(key)) {
        players.set(key, {
          key,
          name: displayName,
          matchesPlayed: 0,
          wins: 0,
          losses: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          rankingPointsEarned: 0,
          titlesWon: 0,
          finalsReached: 0,
          results: [],
          tournamentRecords: new Map()
        });
      }
      return players.get(key);
    }

    const tournamentByIdFromData = new Map([...tournamentDataById].map(([id, data]) => [id, { id, data }]));

    records.forEach(record => {
      const tournament = tournamentByIdFromData.get(record.tournamentId);
      const sides = [record.side1, record.side2];
      sides.forEach((side, sideOffset) => {
        const sideIndex = sideOffset + 1;
        const won = record.winnerSide === sideIndex;
        const opponentSide = sides[sideOffset === 0 ? 1 : 0];
        [...new Set(side.map(normalizeName))].forEach(key => {
          const player = players.get(key);
          if (!player) return;
          player.matchesPlayed++;
          if (won) player.wins++;
          else player.losses++;
          player.pointsFor += sideIndex === 1 ? record.points1 : record.points2;
          player.pointsAgainst += sideIndex === 1 ? record.points2 : record.points1;
          player.rankingPointsEarned += rankingPoints(record, sideIndex, tournament);
          player.results.push({ record, won, opponentSide });
          const tournamentRecord = player.tournamentRecords.get(record.tournamentId) || { played: 0, wins: 0, losses: 0, titles: 0 };
          tournamentRecord.played++;
          if (won) tournamentRecord.wins++;
          else tournamentRecord.losses++;
          if (record.stage === 'finals' && won) tournamentRecord.titles++;
          player.tournamentRecords.set(record.tournamentId, tournamentRecord);
          if (record.stage === 'finals') {
            player.finalsReached++;
            if (won) player.titlesWon++;
          }
        });
      });
    });

    const profiles = new Map();
    profileList.forEach(profile => {
      const key = normalizeName(resolveName(profile.name));
      if (key) profiles.set(key, profile);
    });

    players.forEach(player => {
      const recent = player.results.slice(-5);
      const formWins = recent.filter(result => result.won).length;
      player.winPercentage = player.matchesPlayed ? player.wins / player.matchesPlayed * 100 : 0;
      player.averagePointDifference = player.matchesPlayed
        ? (player.pointsFor - player.pointsAgainst) / player.matchesPlayed
        : 0;
      player.form = recent.length ? recent.map(result => result.won ? 'W' : 'L').join('-') : '—';
      player.formRating = recent.length ? formWins / recent.length * 100 : 0;
      player.longestWinningStreak = 0;
      let streak = 0;
      player.results.forEach(result => {
        streak = result.won ? streak + 1 : 0;
        player.longestWinningStreak = Math.max(player.longestWinningStreak, streak);
      });
      player.undefeatedTournaments = [...player.tournamentRecords.values()]
        .filter(summary => summary.played > 0 && summary.losses === 0 && summary.titles > 0).length;
      const pointDifferenceScore = clamp(50 + player.averagePointDifference * 2, 0, 100);
      const titleScore = Math.min(100, player.titlesWon * 20);
      player.performanceIndex = clamp(
        player.winPercentage * 0.4 + pointDifferenceScore * 0.2 + titleScore * 0.2 + player.formRating * 0.2,
        0,
        100
      );
      player.rating = player.performanceIndex >= 90 ? 'Elite'
        : player.performanceIndex >= 75 ? 'Advanced'
          : player.performanceIndex >= 60 ? 'Intermediate' : 'Beginner';
      player.profile = profiles.get(player.key) || profileForName(player.name) || { name: player.name, photoUrl: '', age: null, club: '', ranking: '' };
      player.playerId = player.profile.playerId || playerProfileIds.get(player.key) || '';
    });

    return {
      records,
      players: [...players.values()].sort((a, b) => b.performanceIndex - a.performanceIndex || a.name.localeCompare(b.name)),
      resolveName,
      getPlayer(name) {
        return players.get(normalizeName(resolveName(name))) || null;
      },
      getTournamentRank(name, tournamentId) {
        const key = normalizeName(resolveName(name));
        const matches = records.filter(record => record.tournamentId === String(tournamentId));
        const rows = rankRecords(matches, tournamentByIdFromData);
        const index = rows.findIndex(row => row.key === key);
        return index < 0 ? null : index + 1;
      },
      getSeedPosition(name, tournamentId) {
        const tournament = tournamentById.get(String(tournamentId));
        if (!tournament || !Array.isArray(tournament.data.qr1Matches) || !tournament.data.qr1Matches.length) return null;
        if (!tournament.data.qr1Matches.every(match => match.completed)) return null;
        const key = normalizeName(resolveName(name));
        const group = (tournament.data.groups || []).find(item =>
          (item.players || []).some(player => normalizeName(resolveName(player)) === key)
        );
        if (!group) return null;
        const matches = records.filter(record => record.tournamentId === String(tournamentId) && record.stage === 'qr1' && record.groupId === group.id);
        const names = new Set((group.players || []).map(player => normalizeName(resolveName(player))));
        const rows = rankRecords(matches, tournamentByIdFromData).filter(row => names.has(row.key));
        const index = rows.findIndex(row => row.key === key);
        return index < 0 ? null : { position: index + 1, total: group.players.length };
      },
      getHeadToHead(nameA, nameB) {
        const keyA = normalizeName(resolveName(nameA));
        const keyB = normalizeName(resolveName(nameB));
        const meetings = [];
        if (!keyA || !keyB || keyA === keyB) return emptyHeadToHead();
        records.forEach(record => {
          const aOnSide1 = record.side1.some(name => normalizeName(name) === keyA);
          const aOnSide2 = record.side2.some(name => normalizeName(name) === keyA);
          const bOnSide1 = record.side1.some(name => normalizeName(name) === keyB);
          const bOnSide2 = record.side2.some(name => normalizeName(name) === keyB);
          if ((aOnSide1 && bOnSide2) || (aOnSide2 && bOnSide1)) {
            const aSide = aOnSide1 ? 1 : 2;
            const aWon = record.winnerSide === aSide;
            meetings.push({
              won: aWon,
              pointsFor: aSide === 1 ? record.points1 : record.points2,
              pointsAgainst: aSide === 1 ? record.points2 : record.points1,
              tournamentName: record.tournamentName,
              tournamentDate: record.tournamentDate
            });
          }
        });
        const wins = meetings.filter(meeting => meeting.won).length;
        let currentWinStreak = 0;
        for (let index = meetings.length - 1; index >= 0 && meetings[index].won; index--) currentWinStreak++;
        const last = meetings[meetings.length - 1];
        return {
          totalMeetings: meetings.length,
          wins,
          losses: meetings.length - wins,
          winPercentage: meetings.length ? wins / meetings.length * 100 : 0,
          averageScoreDifference: meetings.length
            ? meetings.reduce((sum, meeting) => sum + meeting.pointsFor - meeting.pointsAgainst, 0) / meetings.length
            : 0,
          lastMatchResult: last ? `${last.won ? 'Win' : 'Loss'} ${last.pointsFor}–${last.pointsAgainst}` : 'No meetings yet',
          lastTournament: last ? last.tournamentName : '',
          currentWinStreak
        };
      },
      getPartnerships(name) {
        const playerKey = normalizeName(resolveName(name));
        const partnerships = new Map();
        records.forEach(record => {
          if (record.side1.length !== 2 || record.side2.length !== 2) return;
          [record.side1, record.side2].forEach((team, sideOffset) => {
            const keys = team.map(normalizeName);
            if (!keys.includes(playerKey)) return;
            const partnerName = team.find(member => normalizeName(member) !== playerKey);
            if (!partnerName) return;
            const pairKey = JSON.stringify([...keys].sort());
            let partnership = partnerships.get(pairKey);
            if (!partnership) {
              partnership = {
                partnerName,
                matchesPlayedTogether: 0,
                winsTogether: 0,
                titlesTogether: 0,
                totalPoints: 0,
                bestFinishRank: Infinity,
                bestTournamentFinish: '—'
              };
              partnerships.set(pairKey, partnership);
            }
            const won = record.winnerSide === sideOffset + 1;
            partnership.matchesPlayedTogether++;
            if (won) partnership.winsTogether++;
            partnership.totalPoints += sideOffset === 0 ? record.points1 : record.points2;
            if (record.stage === 'finals') {
              const finishRank = won ? 1 : 2;
              if (won) partnership.titlesTogether++;
              updateBestFinish(partnership, finishRank, won ? 'Champion' : 'Runner-up');
            } else if (record.stage === 'semis') {
              updateBestFinish(partnership, 3, 'Semi-finalist');
            }
          });
        });
        return [...partnerships.values()]
          .map(partnership => ({
            ...partnership,
            winRateTogether: partnership.matchesPlayedTogether
              ? partnership.winsTogether / partnership.matchesPlayedTogether * 100
              : 0,
            averagePointsPerMatch: partnership.matchesPlayedTogether
              ? partnership.totalPoints / partnership.matchesPlayedTogether
              : 0
          }))
          .sort((a, b) => b.matchesPlayedTogether - a.matchesPlayedTogether || b.winRateTogether - a.winRateTogether);
      },
      getPrediction(nameA, nameB, targetPoints, deuceCap) {
        const keyA = normalizeName(resolveName(nameA));
        const keyB = normalizeName(resolveName(nameB));
        const playerA = players.get(keyA);
        const playerB = players.get(keyB);
        if (!playerA || !playerB || keyA === keyB) return null;
        const ratingDifference = playerA.performanceIndex - playerB.performanceIndex;
        const modelProbability = 1 / (1 + Math.pow(10, -ratingDifference / 35));
        const confidence = Math.min(1, Math.sqrt(Math.min(playerA.matchesPlayed, playerB.matchesPlayed) / 5));
        const winProbabilityA = 0.5 + (modelProbability - 0.5) * confidence;
        const cap = Number(deuceCap) || 30;
        const target = Number(targetPoints) || 21;
        const expectedA = playerA.matchesPlayed
          ? (playerA.pointsFor / playerA.matchesPlayed + (playerB.matchesPlayed ? playerB.pointsAgainst / playerB.matchesPlayed : target * 0.9)) / 2
          : target * 0.9;
        const expectedB = playerB.matchesPlayed
          ? (playerB.pointsFor / playerB.matchesPlayed + (playerA.matchesPlayed ? playerA.pointsAgainst / playerA.matchesPlayed : target * 0.9)) / 2
          : target * 0.9;
        const lowerRatedWinProbability = ratingDifference === 0 ? 50 : Math.min(winProbabilityA, 1 - winProbabilityA) * 100;
        return {
          winProbabilityA: winProbabilityA * 100,
          winProbabilityB: (1 - winProbabilityA) * 100,
          expectedScoreA: Math.round(clamp(expectedA, 0, cap)),
          expectedScoreB: Math.round(clamp(expectedB, 0, cap)),
          upsetProbability: lowerRatedWinProbability,
          confidence: confidence * 100
        };
      }
    };
  }

  function rankRecords(records, tournamentById) {
    const rows = new Map();
    records.forEach(record => {
      const tournament = tournamentById.get(record.tournamentId);
      [record.side1, record.side2].forEach((side, sideOffset) => {
        const sideIndex = sideOffset + 1;
        side.forEach(name => {
          const key = normalizeName(name);
          const row = rows.get(key) || { key, name, wins: 0, losses: 0, rankingPoints: 0, pointsFor: 0, pointsAgainst: 0 };
          if (record.winnerSide === sideIndex) row.wins++;
          else row.losses++;
          row.rankingPoints += rankingPoints(record, sideIndex, tournament);
          row.pointsFor += sideIndex === 1 ? record.points1 : record.points2;
          row.pointsAgainst += sideIndex === 1 ? record.points2 : record.points1;
          rows.set(key, row);
        });
      });
    });
    return [...rows.values()].sort((a, b) =>
      b.rankingPoints - a.rankingPoints ||
      b.wins - a.wins ||
      (b.pointsFor - b.pointsAgainst) - (a.pointsFor - a.pointsAgainst) ||
      a.name.localeCompare(b.name)
    );
  }

  function updateBestFinish(partnership, rank, label) {
    if (rank < partnership.bestFinishRank) {
      partnership.bestFinishRank = rank;
      partnership.bestTournamentFinish = label;
    }
  }

  function emptyHeadToHead() {
    return {
      totalMeetings: 0,
      wins: 0,
      losses: 0,
      winPercentage: 0,
      averageScoreDifference: 0,
      lastMatchResult: 'No meetings yet',
      lastTournament: '',
      currentWinStreak: 0
    };
  }

  function getBadges(player) {
    if (!player) return [];
    const badges = [];
    if (player.titlesWon > 0) badges.push({ id: 'first-title', label: 'First Tournament Win', icon: '🏆' });
    if (player.wins >= 10) badges.push({ id: 'wins-10', label: '10 Match Wins', icon: '🏆' });
    if (player.wins >= 50) badges.push({ id: 'wins-50', label: '50 Match Wins', icon: '🏆' });
    if (player.wins >= 100) badges.push({ id: 'wins-100', label: '100 Match Wins', icon: '🏆' });
    if (player.longestWinningStreak >= 5) badges.push({ id: 'streak-5', label: '5 Match Winning Streak', icon: '🔥' });
    if (player.undefeatedTournaments > 0) badges.push({ id: 'undefeated', label: 'Undefeated Tournament', icon: '🔥' });
    if (player.titlesWon > 0) badges.push({ id: 'champion', label: 'Tournament Champion', icon: '👑' });
    return badges;
  }

  return { accumulateStandings, buildAnalytics, computeStandings, extractMatchRecords, getBadges, normalizeName };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PlayerAnalytics;
if (typeof window !== 'undefined') window.PlayerAnalytics = PlayerAnalytics;
