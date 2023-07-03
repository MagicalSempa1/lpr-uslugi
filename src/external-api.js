import csvparse from './js-csvparser.js';
import getGoogleAuthToken from './google-auth.js';

class Sheet {
	constructor(api, spreadsheetId, gid, sheetName) {
		this.api = api;
		this.spreadsheetId = spreadsheetId;
		this.gid = gid;
		this.sheetName = sheetName;
	}

	async query(sqlQuery) {
		const table = await this.api.requestGSheets(
			`https://docs.google.com/spreadsheets/d/${this.spreadsheetId}/gviz/tq?gid=${this.gid}&headers=1&tqx=out%3Acsv&tq=${encodeURIComponent(sqlQuery)}`,
			{}
		);

		return csvparse(table).data;
	}

	async append(range, values) {
		let actualRange = `${this.sheetName}!${range}`;
		await this.api.requestGSheets(
			`https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values/${actualRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
			{
				body: JSON.stringify({
					range: actualRange,
					values,
				}),
				method: 'POST',
			}
		);
		return;
	}

	async setValues(range, values) {
		let actualRange = `${this.sheetName}!${range}`;
		await this.api.requestGSheets(`https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values/${actualRange}?valueInputOption=RAW`, {
			body: JSON.stringify({
				range: actualRange,
				values,
			}),
			method: 'PUT',
		});
		return;
	}
}

export class SheetsAPI {
	constructor(user, serviceKey) {
		this.user = user;
		this.serviceKey = serviceKey;
		this.requestGSheets = null;
	}

	async authorize() {
		if (this.requestGSheets) {
			return this;
		}
		const scope = 'https://www.googleapis.com/auth/spreadsheets';
		const token = await getGoogleAuthToken(this.user, this.serviceKey, scope);

		this.requestGSheets = async (url, opt) => {
			let options = opt || {};
			options.headers = new Headers({
				Authorization: `Bearer ${token}`,
			});
			if (options.body) {
				options.headers.set('Content-Type', 'application/json;charset=UTF-8');
			}
			const resp = await fetch(url, options);
			if (!resp.ok) {
				throw new Error(await resp.text());
			}
			return resp.text();
		};
		return this;
	}

	async getSheet(spreadsheetId, gid, sheetName) {
		await this.authorize();
		if (!gid) {
			throw new Error('Sheet gid not found!');
		}
		return new Sheet(this, spreadsheetId, gid, sheetName);
	}
}

export class Trello {
	constructor(trelloKey, trelloToken) {
		this.trelloKey = trelloKey;
		this.trelloToken = trelloToken;
	}

	async makeCall(url, method, query, data) {
		let querystr = `?key=${this.trelloKey}&token=${this.trelloToken}`;
		for (let queryitem in query || {}) {
			querystr += `&${encodeURIComponent(queryitem)}=${encodeURIComponent(query[queryitem])}`;
		}
		const res = await fetch(`https://api.trello.com/${url}${querystr}`, {
			method: method ? method : 'GET',
			body: data ? JSON.stringify(data) : undefined,
			headers: data
				? new Headers({
						'Content-Type': 'application/json;charset=UTF-8',
				  })
				: undefined,
		});
		if (!res.ok) {
			throw new Error(await res.text());
		}
		return res.json();
	}

	async getCard(cardId, query) {
		return this.makeCall(`1/cards/${cardId}`, 'GET', query);
	}

	async updateCard(cardId, data) {
		return this.makeCall(`1/cards/${cardId}`, 'PUT', {}, data);
	}

	async addComment(cardId, text) {
		return this.makeCall(`1/cards/${cardId}/actions/comments`, 'POST', {}, { text });
	}
}

export function telegram(bot_token) {
	return async (command, data) => {
		const resp = await fetch(`https://api.telegram.org/bot${bot_token}/${command}`, {
			method: 'POST',
			body: JSON.stringify(data),
			headers: {
				'Content-Type': 'application/json;charset=UTF-8',
			},
		});
		if (!resp.ok) {
			throw new Error(await resp.text());
		}
	};
}
