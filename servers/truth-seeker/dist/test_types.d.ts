export interface UserProfile {
    id: number;
    name: string;
    email: string;
    isActive?: boolean;
}
export interface CreateUserResponse {
    received: any;
    status: string;
    timestamp: string;
}
