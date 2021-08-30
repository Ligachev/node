
export type OfflineDevicesState = {
    devices?: readonly OfflineDevice[];
    snackbars?: readonly ISnackbar[];
    z3k_settings: Z3KDialogState;
    billing: BillingReduxState;
    account: Account;
};

interface IDevicesUIWindow extends Window {
    store: Store<OfflineDevicesState>;
}

declare const window: IDevicesUIWindow;

document.addEventListener('DOMContentLoaded', async () => {
    const store: Store<OfflineDevicesState> = createStore(
        combineReducers({
            devices: upgradeOfflineDeviceReducer,
            snackbars: upgradeSnackbarReducer,
            z3k_settings: reducer,
        }),
        applyMiddleware(thunkMiddleware)
    );
    window.store = store;
    const sockets = new DoubleSocket();
    await sockets.init();
    const devicesList = new DeviceServer(sockets, store);

    ReactDOM.render(
        <Provider store={store}>
            <App sockets={sockets} devicesList={devicesList} />
        </Provider>,
        document.getElementById('root')
    );
});


