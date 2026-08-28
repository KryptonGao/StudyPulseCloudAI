/**
 * INTERNAL_TEST pricing. These are StudyPulse millipoint coefficients,
 * not vendor list prices. Historical usage stores points_charged at
 * request time and is never recomputed with a later version.
 *
 * millipoints are integer units per token. User points = ceil(sum / 1000).
 */
export const CURRENT_PRICING_VERSION = "2026-08-v1";

export const PRICING = {
	"2026-08-v1": {
		"mimo-v2.5": {
			input: 10,
			output: 30,
			reasoning: 30,
			cache: 5,
			multiplier: 1,
		},
		hy3: {
			input: 40,
			output: 120,
			reasoning: 120,
			cache: 10,
			multiplier: 1,
		},
		"minimax-m3": {
			input: 80,
			output: 240,
			reasoning: 240,
			cache: 20,
			multiplier: 1,
		},
	},
};
