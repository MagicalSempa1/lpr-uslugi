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

const textCleanupRegex = /["'\n\r;\\]/g;
const numberCleanupRegex = /[^0-9+]/g;
const verificationTries = 5;
const descTelegramRegex = /^[ ]*Telegram:.*$/m;
const descTUIDRegex = /^[ ]*TUID:.*$/m;
const descPhoneRegex = /^[ ]*Телефон:.*$/m;
const descEmailRegex = /^[ ]*Email:.*$/m;
const descRegionRegex = /^[ ]*Регион:.*$/m;
const descCityRegex = /^[ ]*Город или населённый пункт:.*$/m;
const descDistrictRegex = /^[ ]*Район:.*$/m;
const descAddressRegex = /^[ ]*Адрес:.*$/m;
const birthDateRegex = /^([0-9]{2})\.([0-9]{2})\.([0-9]{4})$/;

class PrivateMessageHandler {
	constructor(message, env) {
		this.text = message.text;
		this.username = message.chat.username;
		this.chatId = message.chat.id;
		this.fromId = message.from.id;
		this.contact = message.contact;
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
		this.tuid = null;
		this.phone = null;
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

	async setPhone(newPhone) {
		if (newPhone != '') {
			newPhone = this.phoneCleanup(newPhone);
		}
		await this.botState.setValues(`I${this.rowId}:I${this.rowId}`, [[newPhone]]);
	}

	phoneCleanup(phone) {
		let cleanedPhone = phone.replaceAll(numberCleanupRegex, '');
		if (!cleanedPhone.startsWith('+')) {
			if (cleanedPhone.startsWith('8')) {
				cleanedPhone = cleanedPhone.replace('8', '+7');
			} else {
				cleanedPhone = '+' + cleanedPhone;
			}
		}
		return cleanedPhone;
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
		if (this.state.startsWith('changing_')) {
			return this.doChanging();
		}
		if (this.state.startsWith('menu_')) {
			return this.findDestination();
		}
		if (this.state == 'main_menu') {
			return this.findMainMenuDestination();
		}
		console.log('Необрабатываемое состояние! ', this.rowId, this.state, verification);
	}

	async doChanging() {
		let input = this.text.replaceAll(textCleanupRegex, '');
		let data;
		switch (this.state) {
			case 'changing_phone':
				data = (await this.hourlyBase.query(`select A, H, J where T = ${this.tuid}`))[0];
				input = this.phoneCleanup(input);
				await this.updateCardField('H', data[0], data[1], input, 'телефона', descPhoneRegex, data[2], 'Телефон:');
				break;
			case 'changing_email':
				if (!input.includes('@')) {
					await this.setState('menu_changing');
					await this.sendMessage('В email должна быть @');
					return this.sendMenu('Вы в меню изменения учётных данных', await this.buildMenu('menu_changing'));
				}
				data = (await this.hourlyBase.query(`select A, K, J where T = ${this.tuid}`))[0];
				await this.updateCardField('K', data[0], data[1], input, 'email', descEmailRegex, data[2], 'Email:');
				break;
			case 'changing_region':
				data = (await this.hourlyBase.query(`select A, L, J where T = ${this.tuid}`))[0];
				await this.updateCardField('L', data[0], data[1], input, 'региона', descRegionRegex, data[2], 'Регион:');
				break;
			case 'changing_city':
				data = (await this.hourlyBase.query(`select A, N, J where T = ${this.tuid}`))[0];
				await this.updateCardField('N', data[0], data[1], input, 'города', descCityRegex, data[2], 'Город или населённый пункт:');
				break;
			case 'changing_district':
				data = (await this.hourlyBase.query(`select A, M, J where T = ${this.tuid}`))[0];
				await this.updateCardField('M', data[0], data[1], input, 'района', descDistrictRegex, data[2], 'Район:');
				break;
			case 'changing_address':
				data = (await this.hourlyBase.query(`select A, V, J where T = ${this.tuid}`))[0];
				await this.updateCardField('V', data[0], data[1], input, 'адреса', descAddressRegex, data[2], 'Адрес:');
				break;
		}
		await this.setState('menu_changing');
		await this.sendMessage('Данные изменены');
		return this.sendMenu('Вы в меню изменения учётных данных', await this.buildMenu('menu_changing'));
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
		if (targetState != this.state) {
			await this.setState(targetState);
		}
		if (targetState == 'main_menu') {
			if (targetDescription != '') {
				await this.sendMessage(targetDescription);
			}
			return this.sendMainMenu();
		}
		if (targetState.startsWith('changing_')) {
			let data;
			switch (targetState) {
				case 'changing_phone':
					data = (await this.hourlyBase.query(`select H where T = ${this.tuid}`))[0];
					await this.sendMessage('Телефон сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReply('Телефон', 'Введите новый телефон:');
					return;
				case 'changing_email':
					data = (await this.hourlyBase.query(`select K where T = ${this.tuid}`))[0];
					await this.sendMessage('Email сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReply('Email', 'Введите новый email:');
					return;
				case 'changing_region':
					data = (await this.hourlyBase.query(`select L where T = ${this.tuid}`))[0];
					await this.sendMessage('Регион сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReply('Регион', 'Введите новый регион:');
					return;
				case 'changing_city':
					data = (await this.hourlyBase.query(`select N where T = ${this.tuid}`))[0];
					await this.sendMessage('Город сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReply('Город', 'Введите новый город:');
					return;
				case 'changing_district':
					data = (await this.hourlyBase.query(`select M where T = ${this.tuid}`))[0];
					await this.sendMessage('Район сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReply('Район', 'Введите новый район:');
					return;
				case 'changing_address':
					data = (await this.hourlyBase.query(`select V where T = ${this.tuid}`))[0];
					await this.sendMessage('Адрес сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReply('Адрес', 'Введите новый адрес:');
					return;
			}
		}
		if (targetDescription == 'Текущие учётные данные:') {
			const data = (await this.hourlyBase.query(`select H, K, L, M, N, V where T = ${this.tuid}`))[0];
			return this.sendMenu(
				`Текущие учётные данные:\nТелефон: ${data[0]}\nEmail: ${data[1]}\nРегион: ${data[2]}\nГород: ${data[4]}\nРайон: ${data[3]}\nАдрес: ${data[5]}`,
				await this.buildMenu(targetState)
			);
		}
		return this.sendMenu(targetDescription, await this.buildMenu(targetState));
	}

	async findMainMenuDestination() {
		const destText = this.text.replaceAll(textCleanupRegex, '');
		return this.findDestination();
	}

	async sendMainMenu() {
		let buttons = await this.buildMenu('main_menu');
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

	async sendPhoneNicknameMenu() {
		await this.telegram('sendMessage', {
			chat_id: this.chatId,
			text: 'Выберите способ регистрации:',
			reply_markup: {
				keyboard: [[{ text: 'По никнейму' }], [{ text: 'По номеру телефона', request_contact: true }]],
				is_persistent: true,
				resize_keyboard: true,
				one_time_keyboard: true,
			},
		});
	}

	async verifyUser(verification, familyname, name, tuid) {
		switch (this.state) {
			case 'start':
				await this.setState('register_phone');
				await this.sendMessage('Добро пожаловать на ЛПРУслуги. Доступно 2 варианта регистрации по номеру телефона и по никнейму.');
				return this.sendPhoneNicknameMenu();
			case 'register_phone':
				if (this.contact) {
					if (!(this.contact.user_id == this.fromId)) {
						await this.sendMessage(
							'Бот не смог прочитать номер телефона (или прислан чужой номер). Пожалуйста, проверьте настройки приватности. После окончания проверки их можно будет включить обратно.'
						);
						return this.sendPhoneNicknameMenu();
					}
					await this.setPhone(this.contact.phone_number);
				} else if (this.text == 'По никнейму') {
					if (!this.username) {
						await this.sendMessage('Бот не смог прочитать никнейм. Пожалуйста, проверьте настройки приватности. После окончания проверки их можно будет включить обратно.');
						return this.sendPhoneNicknameMenu();
					}
					await this.setPhone('');
				} else {
					await this.sendMessage('Нераспознанная команда');
					return this.sendPhoneNicknameMenu();
				}
				await this.setState('register_familyname');
				await this.forceReply('Фамилия', 'Для проверки введите свою фамилию:');
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

				let cardRow = await this.hourlyBase.query(`select A, J, I, H where E = "${name}" and F = "${familyname}" and O = date "${birthdate}" and T = ${tuid}`);
				if (cardRow.length > 0) {
					let [rowId, cardId, oldUsername, oldPhone] = cardRow[0];
					let username = this.username.replace('@', '');
					if (this.username && oldUsername != username) {
						await this.updateCardField('I', rowId, oldUsername, username, 'юзернейма', descTelegramRegex, cardId, 'Telegram:');
					}
					if (this.phone && oldPhone != this.phone) {
						await this.updateCardField('H', rowId, oldPhone, this.phone, 'телефона', descPhoneRegex, cardId, 'Телефон:');
					}
					return this.verificationComplete(cardId);
				}
				if (this.phone) {
					cardRow = await this.hourlyBase.query(`select A, J, T where E = "${name}" and F = "${familyname}" and O = date "${birthdate}" and H = "${this.phone}"`);
					if (cardRow.length > 0) {
						let [rowId, cardId, oldTuid] = cardRow[0];
						if (oldTuid != '' && tuid != oldTuid) {
							await this.setState('duplicate');
							return this.sendMessage('В системе уже есть такой пользователь. Возможно, эта ошибка вызвана тем, что вы недавно сменили телеграм-аккаунт. Обратитесь в РК');
						}
						await this.updateCardField('T', rowId, oldTuid, parseInt(tuid, 10), 'TUID', descTUIDRegex, cardId, 'TUID:');

						return this.verificationComplete(cardId);
					}
				} else {
					if (!this.username) {
						await this.sendMessage('Бот не смог прочитать никнейм. Пожалуйста, проверьте настройки приватности. После окончания проверки их можно будет включить обратно.');
						await this.sendMessage('Добро пожаловать на ЛПРУслуги. Доступно 2 варианта регистрации по номеру телефона и по никнейму:');
						await this.setState('register_phone');
						return this.sendPhoneNicknameMenu();
					}
					cardRow = await this.hourlyBase.query(`select A, J, T where E = "${name}" and F = "${familyname}" and O = date "${birthdate}" and I = "${username}"`);
					if (cardRow.length > 0) {
						let [rowId, cardId, oldTuid] = cardRow[0];
						if (oldTuid != '' && tuid != oldTuid) {
							await this.setState('duplicate');
							return this.sendMessage('В системе уже есть такой пользователь. Возможно, эта ошибка вызвана тем, что вы недавно сменили телеграм-аккаунт. Обратитесь в РК');
						}
						await this.updateCardField('T', rowId, oldTuid, parseInt(tuid, 10), 'TUID', descTUIDRegex, cardId, 'TUID:');

						return this.verificationComplete(cardId);
					}
				}
				await this.setVerifiсation(parseInt(verification, 10) + 1);
				if (parseInt(verification, 10) + 1 >= verificationTries) {
					if (this.phone) {
						await this.sendMessage('Такие имя, фамилия, дата рождения и телефон не нашлись. Попытки закончились. Обратитесь в РК');
					} else {
						await this.sendMessage('Такие имя, фамилия, дата рождения и никнейм не нашлись. Попытки закончились. Обратитесь в РК');
					}
				} else {
					if (this.phone) {
						await this.sendMessage('Фамилия', 'Такие имя, фамилия и дата рождения не нашлись. Попробуйте ещё раз.');
					} else {
						await this.sendMessage('Фамилия', 'Такие имя, фамилия и дата рождения не нашлись. Попробуйте ещё раз.');
					}
					await this.setState('register_phone');
					return this.sendPhoneNicknameMenu();
				}
				await this.setState('start');
				return;
		}
		console.log('Необрабатываемое состояние! ', this.rowId, this.state, verification);
	}

	async process() {
		this.hourlyBase = await this.sheets.getSheet(this.SPREADSHEET_ID, this.HOURLY_BASE_GID, 'HourlyBase');
		this.botState = await this.sheets.getSheet(this.SPREADSHEET_ID, this.LPR_USLUGI_BOT_STATE_GID, 'LPRUslugiBotState');
		this.botMenu = await this.sheets.getSheet(this.SPREADSHEET_ID, this.LPR_USLUGI_BOT_MENU_GID, 'LPRUslugiBotMenu');
		const selectState = `select A, B, C, D, E, G, H, I where B = ${this.fromId}`;
		let stateRow = await this.botState.query(selectState);
		if (stateRow.length == 0) {
			await this.botState.append('A:E', [['=ROW()', `${this.fromId}`, `${this.chatId}`, 'start', 0]]);
			stateRow = await this.botState.query(selectState);
		}
		let [rowid, tuid, chatid, state, verification, familyname, name, phone] = stateRow[0];
		this.rowId = rowid;
		this.state = state;
		this.tuid = parseInt(tuid, 10);
		this.phone = phone;
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
