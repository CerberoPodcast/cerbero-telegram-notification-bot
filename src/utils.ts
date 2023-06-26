export async function fulfillWithTimeLimit<T>(timeLimit: number, task: Promise<T>): Promise<T> {
    let timeout;
    const timeoutPromise = new Promise<T>((resolve, reject) => {
        timeout = setTimeout(() => {
            reject(new Error('Task timeout!'));
        }, timeLimit);
    });
    const response = await Promise.race([task, timeoutPromise]);
    if (timeout) { //the code works without this but let's be safe and clean up the timeout
        clearTimeout(timeout);
    }
    return response;
}
