import {createSocket, RemoteInfo, Socket} from 'dgram';
import {createStore, Store} from 'redux';
import {SafeDictionary} from 'ts-essentials';
import {
    FileContent,
    FileOpen,
    FileOpenResponse,
    FileRead,
    Message,
    setReadMode,
    TextMessage,
    toHexString,
} from './oldmessages';
import {configDictFromText} from '../Z3KConfigParser/parser/configConvector/fromText/configFromText';
import {parseState} from '../Z3KConfigParser/parser/state/parseState';
import {EthernetState, Z3KConfig, Z3KDeviceState} from '../console/types/z3k-config';
import {OfflineDevice, upgradeOfflineDeviceReducer} from './reducer';
import {
    add_device_action,
    // getDevicesThunkCreator,
    // update_device_action,
    update_device_state_action,
} from './actions';
import {useDispatch} from 'react-redux';
import {Capability} from '../console/device-capability';
import {FileTransfer} from '../console/device';

export type DoubleSocketType = {
    getSocket: MessageSocket;
    sendSocket: MessageSocket;
};

export class DoubleSocket implements DoubleSocketType {
    getSocket: MessageSocket;
    sendSocket: MessageSocket;
    listenerSocket: UDPSocket;
    sendlerSocket: UDPSocket;
    constructor() {
        this.listenerSocket = new UDPSocket(49080);
        this.sendlerSocket = new UDPSocket(49079, 49080);
    }

    async init(): Promise<void> {
        await Promise.all([this.listenerSocket.up(), this.sendlerSocket.up()]);
        this.getSocket = new MessageSocket(this.listenerSocket);
        this.sendSocket = new MessageSocket(this.sendlerSocket);
    }
}

export class UDPSocket {
    readonly socket: Socket;
    constructor(
        readonly listenerSocketPort: number,
        readonly SenderSocketPort?: number
    ) {
        this.socket = createSocket('udp4');
        // this.up();
    }

    async up(): Promise<void> {
        this.socket.on('listening', () => {
            const address = this.socket.address();
            // console.log(`server listening ${address.address}:${address.port}`);
        });

        this.socket.on('message', (buffer: ArrayBuffer, rinfo: RemoteInfo) => {
            const uint8 = new Uint8Array(buffer);
            // console.log('BYTES MESSAGE', uint8);
            const message: Message = Message.fromBinary(uint8);
            // console.log(`
            // server got: ${Message.toHexString(uint8)}\n
            // from ${rinfo.address}:${rinfo.port}\n
            // message: ${message.toString()}
            // `);
        });

        // this.socket.bind(this.listenerSocketPort);

        await new Promise<void>((resolve, reject) =>
            this.socket.bind(this.listenerSocketPort, resolve)
        );
    }

    send(bytes: Uint8Array, addr?: string): void {
        // console.log('BYTES', toHexString(bytes), addr);
        this.socket.setBroadcast(!addr);
        this.socket.send(
            bytes,
            this.SenderSocketPort ? this.SenderSocketPort : this.listenerSocketPort,
            addr ? addr : '255.255.255.255'
        );
    }

    onReceive(callback: (bytes: ArrayBuffer, addr: string) => void): void {
        this.socket.on('message', (buffer: ArrayBuffer, rinfo: RemoteInfo) => {
            callback(buffer, rinfo.address);
        });
    }
}

export class MessageSocket {
    constructor(readonly udpSocket: UDPSocket) {}

    send(msg: Message, addr?: string): void {
        // console.log('SEND MESSAGE: ' + msg + ' FROM SOCKET TO ADDRESS ' + addr);
        this.udpSocket.send(msg.toBinary(), addr);
    }

    onReceive(callback: (message: Message, addr: string) => void): void {
        this.udpSocket.onReceive((bytes, addr) => {
            const uint8: Uint8Array = new Uint8Array(bytes);
            const message: Message = Message.fromBinary(uint8);
            callback(message, addr);
        });
    }
}

class EventSource<E> {
    listeners: Array<(event: E) => void> = [];

    public addListener(listener: (event: E) => void) {
        this.listeners.push(listener);
    }
    public removeListener(listener: (event: E) => void) {
        const index = this.listeners.indexOf(listener);
        if (index != -1) this.listeners.splice(index, 1);
    }
    public fire(event: E) {
        this.listeners.forEach((listener) => listener(event));
    }
}

interface MessageTransport {
    socket: MessageSocket;
    ip: string;
    onMessageReceived(callback: (msg: Message) => void): void;
    send(msg: Message): void;
}

class MutableMessageTransport implements MessageTransport {
    private eventSource: EventSource<Message> = new EventSource<Message>();

    constructor(public readonly socket: MessageSocket, public ip: string) {}

    onMessageReceived(callback: (msg: Message) => void): void {
        this.eventSource.addListener(callback);
    }

    public onMessage(msg: Message) {
        this.eventSource.fire(msg);
    }

    send(msg: Message): void {
        // console.log('SEND FORM MESSAGE TRANSPORT');
        this.socket.send(msg, this.ip);
    }
}

type MessageClass<R extends Message> = {new (...args: any[]): R};

type RequestCollector = SafeDictionary<
    {
        expires: number;
        resolve: (response: Message) => void;
        reject: (error: Error) => void;
        expectedResponseType: MessageClass<Message>;
    },
    number
>;

// type FileCollector = SafeDictionary<
//     {
//         expires: number;
//         resolve: (response: Message) => void;
//         reject: (error: Error) => void;
//         expectedResponseType: MessageClass<Message>;
//         success: boolean;
//         error: boolean;
//     },
//     number
// >;

type TaskNames = 'Read' | 'Write';
export class SmartResponseHandler {
    fileCollector: RequestCollector = {};
    content: Uint8Array = new Uint8Array();
    contentSize: number;
    position: number = 0;
    constructor(
        readonly responseHandler: ResponseHandler,
        readonly messageTransport: MessageTransport
    ) {
        this.messageTransport.onMessageReceived(this.onMessage);
        setInterval(this.responseHandler.onTimer, 10e3);
    }

    async fileTransfer(fileName: string, task: TaskNames) /*Promise<R>*/ {
        const openResponse = await this.responseHandler.sendWithResponse(
            new FileOpen(fileName, setReadMode(), 0, 0),
            FileOpenResponse
        );

        const contentResponse = this.readFile(openResponse);
        // console.log('contentResponse', contentResponse);
        // (task === 'Read' && this.readFile(openResponse))
        // ||
        // (task === 'Write' && this.readFile(openResponse));
        // console.log('FILE CONTENT RESPONSE', contentResponse);

        // const closeResponse = await this.responseHandler.sendWithResponse(
        //     new FileClose(openResponse.handle, 0, 0),
        //     FileCloseResponse
        // );

        return contentResponse;
    }

    async readFile(response: FileOpenResponse): Promise<FileContent> {
        const {fileSize, handle, errorCode} = response;
        this.contentSize = fileSize;
        return await this.sendWithReadFile(
            new FileRead(handle, 0, fileSize, 0, 0),
            FileContent
        );
    }

    sendWithReadFile<R extends Message>(
        msg: FileRead,
        expectedResponseType: MessageClass<R>,
        timeout: number = 60e3
    ): Promise<R> {
        this.responseHandler.setNextAddr(msg);
        this.responseHandler.send(msg);

        return new Promise((resolve, reject) => {
            this.fileCollector[msg.src] = {
                expires: Date.now() + timeout,
                resolve: resolve as (response: Message) => void,
                reject: reject,
                expectedResponseType,
                // success: false,
                // error: false,
            };
        });
    }

    onMessage = (msg: Message) => {
        const request = this.fileCollector[msg.dst];
        if (request) {
            if (msg instanceof FileContent /*request.expectedResponseType*/) {
                // console.log('Message Intercepted');
                if (this.contentSize == msg.position) {
                    // console.log('End of message', this.content);
                    delete this.fileCollector[msg.dst];
                    msg.data = this.content;
                    request.resolve(msg);
                } else if (msg.position == this.position) {
                    const newData = msg.data;
                    // console.log('New Data', newData);

                    this.position += newData.byteLength;
                    // console.log('Position', this.position);

                    // console.log('Content', this.content);
                    this.content = new Uint8Array([...this.content, ...newData]);
                    // console.log('NEW Content', this.content);
                }
            }
        }
    };
}

export class ResponseHandler {
    requests: RequestCollector = {};
    minAddress = 10;
    maxAddress = 250;
    nextAddress: number = this.minAddress;

    constructor(readonly messageTransport: MessageTransport) {
        this.messageTransport.onMessageReceived(this.onMessage);
        setInterval(this.onTimer, 10e3);
    }

    setNextAddr<R extends Message>(msg: Message): void {
        if (Object.keys(this.requests).length >= this.maxAddress - this.minAddress) {
            throw new Error('No available response addresses');
        }

        while (this.requests[this.nextAddress] != null) {
            this.nextAddress++;
            if (this.nextAddress >= this.maxAddress) this.nextAddress = this.minAddress;
        }

        msg.setSRC(this.nextAddress);
        this.nextAddress++;
        if (this.nextAddress >= this.maxAddress) this.nextAddress = this.minAddress;
    }

    send(msg: Message) {
        this.messageTransport.send(msg);
    }

    sendWithResponse<R extends Message>(
        msg: Message,
        expectedResponseType: MessageClass<R>,
        timeout: number = 60e3
    ): Promise<R> {
        this.setNextAddr(msg);
        this.send(msg);
        return new Promise((resolve, reject) => {
            this.requests[msg.src] = {
                expires: Date.now() + timeout,
                resolve: resolve as (response: Message) => void,
                reject: reject,
                expectedResponseType,
            };
        });
    }

    onMessage = (msg: Message) => {
        const request = this.requests[msg.dst];
        // console.log('GET RESPONSE', request);
        if (request) {
            if (msg instanceof request.expectedResponseType) {
                // console.log('FIND IN REQUEST', this.requests[msg.dst]);
                delete this.requests[msg.dst];
                request.resolve(msg);
            }
        }
    };

    onTimer = () => {
        const now = Date.now();
        for (const [addr, pending] of Object.entries(this.requests)) {
            if (!pending) continue;
            if (pending.expires < now) {
                delete this.requests[+addr];
                pending.reject(new Error('timeout'));
            }
        }
    };
}

export class ListenerState {
    state: Z3KDeviceState;
    constructor(
        readonly store: Store,
        readonly counterId: number,
        readonly responseHandler: ResponseHandler,
        readonly messageTransport: MessageTransport,
        readonly config: Z3KConfig
    ) {
        this.state = {};
        this.messageTransport.onMessageReceived(this.onMessage);
        this.getState();
    }

    getState = (): void => {
        this.responseHandler.send(new TextMessage('GETALLSTATES?'));
    };

    onMessage = (msg: Message) => {
        if (msg instanceof TextMessage && msg.message.startsWith('#Y')) {
            // console.log('STATE MESSAGE', msg.message);
            const oneState = parseState(this.config, msg.message);
            const match = /^#Y([0-9]*)/.exec(msg.message);
            // console.log('FOR STATE', match, oneState);
            if (match) {
                const [_, stateId] = match;
                this.state = {
                    ...this.state,
                    [stateId]: oneState,
                };
                this.store.dispatch(
                    update_device_state_action(this.counterId, this.state)
                );
                // console.log('STORE', this.store.getState());
            }
        }
    };
}

export type DeviceDetected = {
    ip: string;
    time: Date;
    model: string;
    transport: MutableMessageTransport;
    protocol: DeviceProtocol;
};

export type DetectionCollector = {
    [serial: string]: DeviceDetected;
};

export class DeviceServer {
    detectionState: DetectionCollector = {};
    counterId: number;
    constructor(readonly DoubleSocket: DoubleSocketType, readonly store: Store) {
        this.DoubleSocket.getSocket.onReceive(this.onMessage);
        this.sendDeviceDetection();
        setInterval(this.sendDeviceDetection, 10e3);
        this.counterId = 0;
    }

    sendDeviceDetection = (): void => {
        this.DoubleSocket.sendSocket.send(new TextMessage('#F', 0, 0));
    };

    onMessage = (msg: Message, addr: string): void => {
        // console.log('Content Message', msg);
        // console.log('From Address', addr);
        if (msg instanceof TextMessage) {
            const match = /^#I([0-9A-Fa-f]{12}):(.*)/.exec(msg.message);
            const matchS7 = /^#S7=([0-9A-Za-z+]*)\s([0-9]*)\s([0-9]*)/.exec(
                msg.message
            );
            if (matchS7) {
                // console.log('matchS7', matchS7);
            }
            if (match) {
                const [_, serial, model] = match;
                // console.log('serial', serial);
                // console.log('model', model);
                const existing = this.detectionState
                    ? this.detectionState[serial]
                    : false;
                if (existing) {
                    // console.log('existing', existing);
                    this.detectionState[serial] = {
                        ...existing,
                        ip: addr,
                        time: new Date(),
                        model: model,
                    };
                    this.detectionState[serial].transport.ip = addr;
                } else {
                    // console.log('not existing');
                    const transport = new MutableMessageTransport(
                        this.DoubleSocket.sendSocket,
                        addr
                    );
                    this.detectionState[serial] = {
                        ip: addr,
                        time: new Date(),
                        model: model,
                        transport: transport,
                        protocol: new DeviceProtocol(
                            this.store,
                            ++this.counterId,
                            serial,
                            transport
                        ),
                    };
                    // console.log('detectionState', this.detectionState);
                }
                return;
            }
        }

        Object.entries(this.detectionState)
            .filter(([serial, state]) => state.ip == addr)
            .forEach(([serial, state]) => {
                state.transport.onMessage(msg);
            });
    };
}

class DeviceProtocol {
    private responseHandler: ResponseHandler;
    private smartResponseHandler: SmartResponseHandler;
    private listenerState: ListenerState;
    constructor(
        public readonly store: Store,
        public readonly counterId: number,
        public readonly serial: string,
        public readonly transport: MessageTransport,
        public config?: Z3KConfig
    ) {
        this.responseHandler = new ResponseHandler(this.transport);
        this.smartResponseHandler = new SmartResponseHandler(
            this.responseHandler,
            this.transport
        );

        // this.config = await this.getConfig();
        // this.getConfig().then();
        // this.askVersion().then();
        // this.goToReducer().then();
        // this.getAllState().then();

        this.initialConfigAndState().then();
    }

    async goToReducer() {
        // console.log('GoToReducerWithoutDev');
        const devVersion = await this.askVersion();
        const match = /^#S7=([0-9A-Za-z+]*)\s([0-9]*)\s([0-9]*)/.exec(
            devVersion.message.trim()
        );
        if (match) {
            // console.log('GoToReducerWitMatch', match);
            const [_, model, hw, fw] = match;

            const dev: OfflineDevice = {
                id: this.counterId,
                serial: this.serial,
                device_type: {
                    code: model,
                    name: CodeToName[model] ?? model,
                },
                hardware_type: {
                    code: hw,
                    name: hw,
                },
                firmware_version: [+fw],
                z3k_config: this.config,
                z3k_state: this.listenerState.state,
                capabilities: [
                    Capability.has_z3k_settings,
                    Capability.has_voltage_sensor,
                    Capability.has_wifi,
                ],
                // ethernet_state: {} as Partial<EthernetState>,
                // filetransfers: [] as Partial<FileTransfer>[],
            };
            // console.log('GoToReducer', dev);
            this.store.dispatch(add_device_action(dev));
            // console.log('STORE', this.store.getState());
        }
    }

    async initialConfigAndState() {
        // console.log('Initial Config And State');
        this.config = await this.getConfig();
        this.listenerState = new ListenerState(
            this.store,
            this.counterId,
            this.responseHandler,
            this.transport,
            this.config
        );
        await this.goToReducer();
    }

    async getConfig() {
        // console.log('Get Config Start');
        const contentResponse = await this.smartResponseHandler.fileTransfer(
            'config.txt',
            'Read'
        );
        // console.log('Get Config: ', contentResponse.data);
        const content = contentResponse.data;
        let decoder = new TextDecoder('windows-1251', {fatal: true});
        const contentText = decoder.decode(content);
        // console.log('CONTENT TEXT', contentText);
        return configDictFromText(contentText);
    }

    async getAllState(): Promise<TextMessage> {
        const response = await this.responseHandler.sendWithResponse(
            new TextMessage('GETALLSTATES?'),
            TextMessage
        );
        // console.log('STATE: ', response);
        return response;
    }

    async askVersion(): Promise<TextMessage> {
        // console.log('Ask Version:');
        const response = await this.responseHandler.sendWithResponse(
            new TextMessage('#S7?'),
            TextMessage
        );
        // console.log('VERSION:', response);
        return response;
    }

    async openFile(): Promise<FileOpenResponse> {
        // console.log('Open file');
        const response = await this.responseHandler.sendWithResponse(
            new FileOpen('config.txt', setReadMode(), 0, 0),
            FileOpenResponse
        );
        return response;
    }

    async ReadFile(
        handle: number,
        startPosition: number,
        length: number
    ): Promise<FileContent> {
        // console.log('Read file');
        const response = await this.responseHandler.sendWithResponse(
            new FileRead(handle, startPosition, length, 0, 0),
            FileContent
        );
        return response;
    }
}

export const CodeToName: Record<string, string | undefined> = {
    SX250: 'Mega SX-LRW',
    SX170: 'Mega SX-170',
    SX300: 'Mega SX-300',
    SX350: 'Mega SX-350',
    H1000: 'ZONT H-1000',
    H2000: 'ZONT H-2000',
    T100: 'ZONT H-1',
    T102: 'ZONT H-2',
    L1000: 'ZONT L-1000',
    L1000S: 'ZONT L-1000 Sim',
    tracker: 'Tracker',
    'ZTC-100': 'ZTC-100',
    'ZTC-110': 'ZTC-110',
    'ZTC-100M': 'ZTC-100M',
    'ZTC-110M': 'ZTC-110M',
    'ZTC-500': 'ZTC-500',
    'ZTC-700': 'ZTC-700',
    'ZTC-700M': 'ZTC-700M',
    'ZTC-700S': 'ZTC-700S',
    'ZTC-701M': 'ZTC-701M',
    'ZTC-710': 'ZTC-710',
    'ZTC-720': 'ZTC-720',
    'ZTC-800': 'ZTC-800',
    'ZTC-111': 'ZTC-111',
    'ZTC-120': 'ZTC-120',
    'ZTC-200': 'ZTC-200',
    'ZTA-110': 'ZTA-110',
    'GTW-100': 'ZONT EXPERT',
    'GTW-102': 'GTW-102',
    'GLT-100': 'GLT-100',
    'G-100': 'G-100',
    'E-100': 'E-100',
    'G-100M': 'G-100M',
    'E-100M': 'E-100M',
    A200: 'A200',
    A200E: 'A200E',
    A100: 'A100',
    A110: 'A110',
    A100M: 'A100M',
    A110M: 'A110M',
    H2001: 'ZONT H-2001',
    'H1000+': 'ZONT H1000+',
    'H2000+': 'ZONT H2000+',
    'CLIMATIC+': 'ZONT CLIMATIC+',
    VALTEC_1: 'ZONT VALTEC 1',
    VALTEC_K300: 'VALTEC K300',
    'C2000+': 'ZONT C2000+',
    A300: 'ZONT A300',
    A400: 'ZONT A400',
    'SMART+': 'ZONT SMART 2.0',
    CLIMATIC: 'ZONT CLIMATIC',
    NAVTEL: 'Навтелеком',
    EGTS: 'ЕГТС',
    GALILEO: 'Галилео',
    ARNAVI: 'Arnavi',
    WIALONBIN: 'Wialon',
    TELTONIK: 'Teltonika',
    SATSOL: 'Satellite Solutions',
    NEOMATIK: 'Неоматика',
    A000: 'Автоскан GPS',
    'ZTC-900': 'ZTC-900',
    SMART_1_0: 'SMART 1.0',
    H1V_PLUS: 'ZONT H1V+',
    CONNECT_PLUS: 'ZONT Connect+',
    GRANIT: 'Гранит',
};

