import { Trello, telegram, SheetsAPI } from './external-api.js';

export default {
	async fetch(request, env, ctx) {
		let url = new URL(request.url);
		if (url.pathname == '/lpr-uslugi-bot') {
			if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') != env.TELEGRAM_HEADER_SECRET) {
				return new Response('Not Found', {
					status: 404,
					statusText: 'Not Found',
				});
			}

			const update = await request.json();

			try {
				if (update.message && update.message.chat.type === 'private') {
					await new PrivateMessageHandler(update.message, env).process();
				}
			} catch (err) {
				console.error(`Error: ${err} ; Stack: ${err.stack}`);
			}

			return new Response('OK', {
				headers: { 'content-type': 'text/plain' },
			});
		}
		return new Response('Not Found', {
			status: 404,
		});
	},
};

const textCleanupRegex = /[@"'\n\r;\\]/g;
const verificationTries = 5;
const descTelegramRegex = /^[ ]*Telegram:.*$/m;
const descTUIDRegex = /^[ ]*TUID:.*$/m;
const birthDateRegex = /^([0-9]{2})\.([0-9]{2})\.([0-9]{4})$/;

class PrivateMessageHandler {
	constructor(message, env) {
		this.text = message.text;
		this.username = message.chat.username;
		this.chatId = message.chat.id;
		this.fromId = message.from.id;
		this.sheets = new SheetsAPI(env.SERVICE_USER, env.SERVICE_KEY);
		this.SPREADSHEET_ID = env.SPREADSHEET_ID;
		this.HOURLY_BASE_GID = env.HOURLY_BASE_GID;
		this.LPR_USLUGI_BOT_STATE_GID = env.LPR_USLUGI_BOT_STATE_GID;
		this.LPR_USLUGI_BOT_MENU_GID = env.LPR_USLUGI_BOT_MENU_GID;
		this.hourlyBase = null;
		this.botState = null;
		this.telegram = telegram(env.TELEGRAM_BOT_TOKEN);
		this.trello = new Trello(env.TRELLO_KEY, env.TRELLO_TOKEN);
		this.state = null;
		this.rowId = null;
	}

	async setChatId() {
		await this.botState.setValues(`C${this.rowId}:C${this.rowId}`, [[this.chatId]]);
	}

	async setState(newState) {
		await this.botState.setValues(`D${this.rowId}:D${this.rowId}`, [[newState]]);
	}

	async setVerifiсation(newVerification) {
		await this.botState.setValues(`E${this.rowId}:E${this.rowId}`, [[newVerification]]);
	}

	async setFamilyname(newFamilyname) {
		await this.botState.setValues(`G${this.rowId}:G${this.rowId}`, [[newFamilyname.replaceAll(textCleanupRegex, '').toLowerCase()]]);
	}

	async setName(newName) {
		await this.botState.setValues(`H${this.rowId}:H${this.rowId}`, [[newName.replaceAll(textCleanupRegex, '').toLowerCase()]]);
	}

	async sendMessage(text) {
		await this.telegram('sendMessage', {
			chat_id: this.chatId,
			text: text,
		});
	}

	async forceReply(placeholder, text) {
		await this.telegram('sendMessage', {
			chat_id: this.chatId,
			text: text,
			reply_markup: {
				force_reply: true,
				input_field_placeholder: placeholder,
			},
		});
	}

	async doMenus() {
		if (this.state.startsWith('menu_')) {
			return this.findDestination();
		}
		if (this.state == 'main_menu') {
			return this.findMainMenuDestination();
		}
		console.log('Необрабатываемое состояние! ', this.rowId, this.state, verification);
	}

	async buildMenu(targetState) {
		const states = await this.botMenu.query(`select A, B where A = "${targetState}"`);
		return states.map((state) => [{ text: state[1] }]);
	}

	async findMenuDescription() {
		const description = await this.botMenu.query(`select D where C = "${this.state}"`);
		return description[0][0];
	}

	async findDestination() {
		const destination = await this.botMenu.query(`select C, D where A = "${this.state}" and B = "${this.text.replaceAll(textCleanupRegex, '')}"`);
		if (destination.length == 0) {
			await this.sendMessage('Не знаю такой команды');
			if (this.state == 'main_menu') {
				return this.sendMainMenu();
			} else {
				return this.sendMenu(await this.findMenuDescription(), await this.buildMenu(this.state));
			}
		}
		let [targetState, targetDescription] = destination[0];
		await this.setState(targetState);
		if (targetState == 'main_menu') {
			if (targetDescription != '') {
				await this.sendMessage(targetDescription);
			}
			return this.sendMainMenu();
		} else {
			return this.sendMenu(targetDescription, await this.buildMenu(targetState));
		}
	}

	async findMainMenuDestination() {
		const destText = this.text.replaceAll(textCleanupRegex, '');
		if (destText == 'Уточнить учётные данные') {
			return this.sendMainMenu();
		}
		return this.findDestination();
	}

	async sendMainMenu() {
		let buttons = await this.buildMenu('main_menu');
		buttons.push([{ text: 'Уточнить учётные данные' }]);
		await this.telegram('sendMessage', {
			chat_id: this.chatId,
			text: 'Вы в главном меню',
			reply_markup: {
				keyboard: buttons,
				is_persistent: true,
				resize_keyboard: true,
				one_time_keyboard: true,
			},
		});
	}

	async sendMenu(description, buttons) {
		await this.telegram('sendMessage', {
			chat_id: this.chatId,
			text: description != '' ? description : ' ',
			reply_markup: {
				keyboard: buttons,
				is_persistent: true,
				resize_keyboard: true,
				one_time_keyboard: true,
			},
		});
	}

	async verificationComplete(trelloCardId) {
		await this.setState('main_menu');
		await this.setVerifiсation('done');
		await this.sendMessage('Проверка пройдена!');
		await this.sendMainMenu();
	}

	async updateCardField(tableColumn, rowId, oldData, newData, dataType, testRegex, cardId, cardField) {
		if (oldData == newData) {
			return;
		}
		await this.hourlyBase.setValues(`${tableColumn}${rowId}:${tableColumn}${rowId}`, [[newData]]);
		await this.trello.addComment(cardId, `ЛПРУслуги;${new Date()};Уточнение ${dataType};${oldData};${newData}`);
		let { desc } = await this.trello.getCard(cardId, { fields: 'desc' });
		if (testRegex.test(desc)) {
			desc = desc.replace(testRegex, `${cardField} ${newData}`);
		} else {
			desc = `${cardField} ${newData}` + '\n' + desc;
		}
		await this.trello.updateCard(cardId, {
			desc,
		});
	}

	async verifyUser(verification, familyname, name, tuid) {
		switch (this.state) {
			case 'start':
				if (!this.username) {
					await this.sendMessage('Бот не смог прочитать никнейм. Пожалуйста, проверьте настройки приватности. После окончания проверки их можно будет включить обратно.');
				}
				await this.setState('register_familyname');
				await this.forceReply('Фамилия', 'Добро пожаловать в ЛПРУслуги. Давайте удостоверимся что Вы это Вы. Для проверки введите свою фамилию:');
				return;
			case 'register_familyname':
				await this.setState('register_name');
				await this.setFamilyname(this.text);
				await this.forceReply('Имя', 'И ещё для проверки введите имя:');
				return;
			case 'register_name':
				await this.setState('register_birthdate');
				await this.setName(this.text);
				await this.forceReply('ДД.ММ.ГГГГ', 'А также введите дату рождения в формате ДД.ММ.ГГГГ');
				return;
			case 'register_birthdate':
				let birthdate = this.text;
				let matches;
				if (!(matches = birthdate.match(birthDateRegex))) {
					await this.forceReply('ДД.ММ.ГГГГ', 'Дата рождения введена не в формате ДД.ММ.ГГГГ Попробуйте ещё раз:');
					return;
				} else {
					birthdate = `${matches[3]}-${matches[2]}-${matches[1]}`;
				}
				if (!this.username) {
					await this.sendMessage('Бот не смог прочитать никнейм. Пожалуйста, проверьте настройки приватности. После окончания проверки их можно будет включить обратно.');
					return;
				}
				let username = this.username.replace('@', '');
				let cardRow = await this.hourlyBase.query(`select A, J, I where E = "${name}" and F = "${familyname}" and O = date "${birthdate}" and T = ${tuid}`);
				if (cardRow.length > 0) {
					let [rowId, cardId, oldUsername] = cardRow[0];
					if (oldUsername != username) {
						await this.updateCardField('I', rowId, oldUsername, username, 'юзернейма', descTelegramRegex, cardId, 'Telegram:');
					}
					return this.verificationComplete(cardId);
				}
				cardRow = await this.hourlyBase.query(`select A, J, T where E = "${name}" and F = "${familyname}" and O = date "${birthdate}" and I = "${username}"`);
				if (cardRow.length > 0) {
					let [rowId, cardId, oldTuid] = cardRow[0];
					if (oldTuid != '' && tuid != oldTuid) {
						await this.setState('duplicate');
						return this.sendMessage('В системе уже есть такой пользователь. Возможно, эта ошибка вызвана тем, что вы недавно сменили телеграм-аккаунт. Обратитесь в РК');
					}
					await this.updateCardField('T', rowId, oldTuid, tuid, 'TUID', descTUIDRegex, cardId, 'TUID:');

					return this.verificationComplete(cardId);
				}
				await this.setVerifiсation(parseInt(verification, 10) + 1);
				if (parseInt(verification, 10) + 1 >= verificationTries) {
					await this.sendMessage('Такие имя, фамилия и дата рождения не нашлись. Попытки закончились. Обратитесь в РК');
				} else {
					await this.forceReply('Фамилия', 'Такие имя, фамилия и дата рождения не нашлись. Попробуйте ещё раз. Введите фамилию:');
				}
				return this.setState('register_familyname');
		}
		console.log('Необрабатываемое состояние! ', this.rowId, this.state, verification);
	}

	async process() {
		this.hourlyBase = await this.sheets.getSheet(this.SPREADSHEET_ID, this.HOURLY_BASE_GID, 'HourlyBase');
		this.botState = await this.sheets.getSheet(this.SPREADSHEET_ID, this.LPR_USLUGI_BOT_STATE_GID, 'LPRUslugiBotState');
		this.botMenu = await this.sheets.getSheet(this.SPREADSHEET_ID, this.LPR_USLUGI_BOT_MENU_GID, 'LPRUslugiBotMenu');
		const selectState = `select A, B, C, D, E, G, H where B = ${this.fromId}`;
		let stateRow = await this.botState.query(selectState);
		if (stateRow.length == 0) {
			await this.botState.append('A:E', [['=ROW()', `${this.fromId}`, `${this.chatId}`, 'start', 0]]);
			stateRow = await this.botState.query(selectState);
		}
		let [rowid, tuid, chatid, state, verification, familyname, name] = stateRow[0];
		this.rowId = rowid;
		this.state = state;
		if (chatid != this.chatId) {
			await this.setChatId();
		}
		switch (verification) {
			case 'duplicate':
				return this.sendMessage('В системе уже есть такой пользователь. Возможно, эта ошибка вызвана тем, что вы недавно сменили телеграм-аккаунт. Обратитесь в РК');
			case 'done':
				return this.doMenus();
		}
		if (parseInt(verification, 10) >= verificationTries) {
			return this.sendMessage('Превышено количество попыток проверки. Обратитесь в РК');
		} else {
			return this.verifyUser(verification, familyname, name, tuid);
		}
	}
}