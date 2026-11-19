'use strict';

const TournamentDraw = (() => {
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

  return { drawSemiFinalPartners };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TournamentDraw;
if (typeof window !== 'undefined') window.TournamentDraw = TournamentDraw;
