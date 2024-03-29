import { Trello, telegram, SheetsAPI } from './external-api.js';

function processUpdate(update, env) {
	try {
		if (update.message && update.message.chat.type === 'private') {
			return new PrivateMessageHandler(update.message, env).process();
		}
		if (update.message && (update.message.chat.type === 'group' || update.message.chat.type === 'supergroup')) {
			return new GroupMessageHandler(update.message, env).process();
		}
	} catch (err) {
		console.error(`Error: ${err} ; Stack: ${err.stack}`);
	}
}

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

			await processUpdate(update, env);

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
		this.text = message.text || '';
		this.username = message.chat.username;
		this.messageId = message.message_id;
		this.chatId = message.chat.id;
		this.fromId = message.from.id;
		this.contact = message.contact;
		this.sheets = new SheetsAPI(env.SERVICE_USER, env.SERVICE_KEY);
		this.SPREADSHEET_ID = env.SPREADSHEET_ID;
		this.HOURLY_BASE_GID = env.HOURLY_BASE_GID;
		this.LPR_USLUGI_BOT_STATE_GID = env.LPR_USLUGI_BOT_STATE_GID;
		this.LPR_USLUGI_BOT_MENU_GID = env.LPR_USLUGI_BOT_MENU_GID;
		this.MRK_CHAT_ID = parseInt(env.MRK_CHAT_ID, 10);
		this.EMERGENCY_CHAT_ID = parseInt(env.EMERGENCY_CHAT_ID, 10);
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

	async sendFormattedMessage(text) {
		await this.telegram('sendMessage', {
			chat_id: this.chatId,
			text: text || ' ',
			parse_mode: 'HTML',
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

	async forceReplyWithCancel(placeholder, text) {
		await this.telegram('sendMessage', {
			chat_id: this.chatId,
			text: text,
			reply_markup: {
				force_reply: true,
				input_field_placeholder: placeholder,
				keyboard: [[{ text: 'Отмена' }]],
				is_persistent: true,
				resize_keyboard: true,
				one_time_keyboard: false,
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
		if (this.state == 'chat' || this.state == 'emergency_chat') {
			return this.doChat();
		}
		if (this.state == 'emergency_confirm') {
			return this.emergencyConfirm();
		}
		console.log('Необрабатываемое состояние! ', this.rowId, this.state);
	}

	async doChat() {
		if (this.state == 'chat' && this.text.toLowerCase() == 'выход') {
			await this.setState('main_menu');
			await this.sendMessage('Выходим из чата в главное меню.');
			return this.sendMainMenu();
		}
		try {
			let user = (await this.hourlyBase.query(`select H, I, D where T = ${this.tuid}`))[0];
			switch (this.state) {
				case 'chat':
					await this.sendToMRK(`ЛПРУслуги-чат; ${user[1] != '' ? `@${user[1]}` : `${user[0]}; ${user[2]}`}; (${this.tuid}):`);
					await this.telegram('copyMessage', {
						chat_id: this.MRK_CHAT_ID,
						from_chat_id: this.chatId,
						message_id: this.messageId,
					});
					break;
				case 'emergency_chat':
					await this.sendToEmergency(`ЛПРУслуги-чат; ${user[1] != '' ? `@${user[1]}` : `${user[0]}; ${user[2]}`}; (${this.tuid}):`);
					await this.telegram('copyMessage', {
						chat_id: this.EMERGENCY_CHAT_ID,
						from_chat_id: this.chatId,
						message_id: this.messageId,
					});
					break;
			}
		} catch (err) {}
	}

	async sendToMRK(text) {
		await this.telegram('sendMessage', {
			chat_id: this.MRK_CHAT_ID,
			text: text,
		});
		await this.sendMessage('Сообщение доставлено');
	}

	async sendToEmergency(text) {
		await this.telegram('sendMessage', {
			chat_id: this.EMERGENCY_CHAT_ID,
			text: text,
		});
		await this.sendMessage('Сообщение доставлено');
	}

	async emergencyConfirm() {
		if (this.text != 'Да. Задержан.') {
			await this.setState('main_menu');
			await this.sendMessage('Задержание не подтверждено. Возвращаемся в главное меню.');
			return this.sendMainMenu();
		}
		try {
			let user = (await this.hourlyBase.query(`select D, C, H, I, K, L, N, M, V where T = ${this.tuid}`))[0];
			await this.sendToEmergency(`ЗАДЕРЖАНИЕ! (${this.tuid}) ${user[0]}; ${user[1]}; ${user[2]}; @${user[3]}; ${user[4]}; ${user[5]}; ${user[6]}; ${user[7]}; ${user[8]}`);
		} catch (err) {
			console.log(err);
			return;
		}
		await this.setState('emergency_chat');
		return this.sendMessage('Задержание подтверждено! Учётная запись заблокирована и переведена в режим связи с правозащитным чатом. Все сообщения пересылаются в чат правозащиты.');
	}

	async doChanging() {
		let input = this.text.replaceAll(textCleanupRegex, '');
		let data;
		if (input.toLowerCase() === 'отмена') {
			await this.setState('menu_changing');
			await this.sendMessage('Возвращаемся без изменений');
			return this.sendMenu('Вы в меню изменения учётных данных', await this.buildMenu('menu_changing'));
		}
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
					await this.forceReplyWithCancel('Телефон', 'Введите новый телефон:');
					return;
				case 'changing_email':
					data = (await this.hourlyBase.query(`select K where T = ${this.tuid}`))[0];
					await this.sendMessage('Email сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReplyWithCancel('Email', 'Введите новый email:');
					return;
				case 'changing_region':
					data = (await this.hourlyBase.query(`select L where T = ${this.tuid}`))[0];
					await this.sendMessage('Регион сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReplyWithCancel('Регион', 'Введите новый регион:');
					return;
				case 'changing_city':
					data = (await this.hourlyBase.query(`select N where T = ${this.tuid}`))[0];
					await this.sendMessage('Город сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReplyWithCancel('Город', 'Введите новый город:');
					return;
				case 'changing_district':
					data = (await this.hourlyBase.query(`select M where T = ${this.tuid}`))[0];
					await this.sendMessage('Район сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReplyWithCancel('Район', 'Введите новый район:');
					return;
				case 'changing_address':
					data = (await this.hourlyBase.query(`select V where T = ${this.tuid}`))[0];
					await this.sendMessage('Адрес сейчас:');
					await this.sendMessage(`${data[0]}`);
					await this.forceReplyWithCancel('Адрес', 'Введите новый адрес:');
					return;
			}
		}
		if (targetState == 'emergency_confirm') {
			return this.telegram('sendMessage', {
				chat_id: this.chatId,
				text: 'Подтвердите задержание. Правозащитный чат получит сообщение о задержании. УЧЁТНАЯ ЗАПИСЬ БУДЕТ ЗАБЛОКИРОВАНА! Но будет доступна пересылка сообщений в чат правозащиты.',
				reply_markup: {
					keyboard: [[{ text: 'Да. Задержан.' }], [{ text: 'Нет. Вернуться в главное меню' }]],
					is_persistent: true,
					resize_keyboard: true,
					one_time_keyboard: true,
				},
			});
		}
		if (targetState == 'chat') {
			return this.telegram('sendMessage', {
				chat_id: this.chatId,
				text: 'Вы в чате обратной связи с МРК. Все сообщения пересылаются в чат МРК. Для выхода из чата нажмите кнопку "выход" или напишите "выход".',
				reply_markup: {
					keyboard: [[{ text: 'Выход' }]],
					is_persistent: true,
					resize_keyboard: true,
					one_time_keyboard: false,
				},
			});
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

	async fixFormatting(text) {
		const fix = /[\\_*\[\]()~>#+\-=|\{\}.!]/g;
		const newText = text.replaceAll(fix, (match) => `\\\\${match}`);
		return newText;
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
			parse_mode: 'HTML',
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
				this.username = this.username.replace('@', '');
				if (cardRow.length > 0) {
					let [rowId, cardId, oldUsername, oldPhone] = cardRow[0];
					if (this.username && oldUsername != this.username) {
						await this.updateCardField('I', rowId, oldUsername, this.username, 'юзернейма', descTelegramRegex, cardId, 'Telegram:');
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
					cardRow = await this.hourlyBase.query(`select A, J, T where E = "${name}" and F = "${familyname}" and O = date "${birthdate}" and I = "${this.username}"`);
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
						await this.sendMessage('Такие имя, фамилия, дата рождения и телефон не нашлись. Попытки закончились. Обратитесь в МРК');
					} else {
						await this.sendMessage('Такие имя, фамилия, дата рождения и никнейм не нашлись. Попытки закончились. Обратитесь в МРК');
					}
				} else {
					if (this.phone) {
						await this.sendMessage(
							'Такие телефон, имя, фамилия или дата рождения не нашлись. Попробуйте ещё раз и проверьте, что данные соответствуют тем с которыми вступали в партию. Фамилия:'
						);
					} else {
						await this.sendMessage(
							'Такие никнейм, имя, фамилия или дата рождения не нашлись. Попробуйте ещё раз и проверьте, что данные соответствуют тем с которыми вступали в партию. Фамилия:'
						);
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

const reLPRUslugiChat = /^ЛПРУслуги-чат;.*?\((.*?)\).*/;
const reLPREmergencyChat = /^ЗАДЕРЖАНИЕ!.*?\((.*?)\).*/;
class GroupMessageHandler {
	constructor(message, env) {
		this.text = message.text || '';
		this.chatId = message.chat.id;
		this.messageId = message.message_id;
		this.reply = message.reply_to_message;
		this.MRK_CHAT_ID = parseInt(env.MRK_CHAT_ID, 10);
		this.EMERGENCY_CHAT_ID = parseInt(env.EMERGENCY_CHAT_ID, 10);
		this.telegram = telegram(env.TELEGRAM_BOT_TOKEN);
	}

	async process() {
		if (this.chatId != this.MRK_CHAT_ID && this.chatId != this.EMERGENCY_CHAT_ID) {
			try {
				await this.telegram('sendMessage', {
					chat_id: this.chatId,
					text: `${this.chatId}`,
				});
				return this.telegram('leaveChat', {
					chat_id: this.chatId,
				});
			} catch (err) {
				return Promise.resolve();
			}
		}
		if (this.reply) {
			let replyMatch = (this.reply.text || '').match(reLPRUslugiChat);
			if (replyMatch) {
				return this.resendToUser(parseInt(replyMatch[1], 10));
			}
			replyMatch = (this.reply.text || '').match(reLPREmergencyChat);
			if (replyMatch) {
				return this.resendToUser(parseInt(replyMatch[1], 10));
			}
		}
	}

	async resendToUser(replyChatId) {
		try {
			switch (this.chatId) {
				case this.MRK_CHAT_ID:
					await this.telegram('sendMessage', {
						chat_id: replyChatId,
						text: `МРК написал:`,
					});
					await this.telegram('copyMessage', {
						chat_id: replyChatId,
						from_chat_id: this.MRK_CHAT_ID,
						message_id: this.messageId,
					});
					break;
				case this.EMERGENCY_CHAT_ID:
					await this.telegram('sendMessage', {
						chat_id: replyChatId,
						text: `Из правозащитной группы:`,
					});
					await this.telegram('copyMessage', {
						chat_id: replyChatId,
						from_chat_id: this.EMERGENCY_CHAT_ID,
						message_id: this.messageId,
					});
					break;
			}
			await this.telegram('sendMessage', {
				chat_id: this.chatId,
				text: 'Сообщение доставлено',
			});
		} catch (err) {
			return console.error(err);
		}
	}
}
